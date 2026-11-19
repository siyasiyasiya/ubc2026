/**
 * `ArcWalletAdapter`: the production WalletAdapter, backed by the `GroupTreasury` contract on Arc.
 *
 * The contract, not this code, enforces the money rules: a share is pulled only after the member's
 * 👍 is recorded onchain, and never beyond what's left of the limit the member signed with Face ID.
 * This adapter holds the operator key, which can propose, relay 👍s and settle, but can't raise a
 * limit or send money anywhere but the split's payee.
 *
 * The port pulls one member at a time while the contract settles whole splits, so each pull is a
 * one-person split: `propose` -> `approveFor` (relaying the 👍 the state machine already collected)
 * -> `settle`. The split id is derived from the pull's idempotency key, so a retry resumes from
 * whatever step finished last and a settled pull is never paid twice.
 */

import {
  micros,
  type LimitStatus,
  type Member,
  type PullOutcome,
  type PullParams,
  type Usdc,
  type WalletAdapter,
} from "@gta/core";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  toBytes,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { groupTreasuryAbi } from "./treasury-abi.js";

/** The contract's group key for a chat: `keccak256("chat:" + chatId)`. */
export function groupIdForChat(chatId: string): Hex {
  return keccak256(toBytes(`chat:${chatId}`));
}

/** The onchain split id for one pull. */
export function pullSpendId(chatId: string, idempotencyKey: string): Hex {
  return keccak256(toBytes(`pull:${chatId}:${idempotencyKey}`));
}

/** The public Arc RPC rejects `eth_getLogs` ranges much larger than this. */
const LOG_WINDOW_BLOCKS = 2_000n;
/** How far back a restart-recovery lookup goes (about 1M blocks). */
const LOG_WINDOWS = 500;

const enum SpendStatus {
  None = 0,
  Proposed = 1,
  Settled = 2,
  Cancelled = 3,
}

export interface ArcWalletAdapterOptions {
  /** Deployed `GroupTreasury` address. */
  treasury: Address;
  /** The group chat this adapter pulls for; limits are per chat. */
  chatId: string;
  publicClient: PublicClient;
  /** Signs as the treasury's operator. */
  walletClient: WalletClient<Transport, Chain, Account>;
  /** How long the onchain approval window stays open; settle happens right away. Default 1h. */
  approvalWindowSeconds?: number;
  /** Block the treasury was deployed at, to bound log lookups when resuming a settled pull. */
  deployBlock?: bigint;
}

export class ArcWalletAdapter implements WalletAdapter {
  readonly id = "arc";
  private readonly group: Hex;
  private readonly inFlight = new Map<Hex, Promise<PullOutcome>>();
  /** Outcomes already settled onchain, so a retry in the same process answers without the RPC. */
  private readonly settled = new Map<Hex, PullOutcome>();

  constructor(private readonly opts: ArcWalletAdapterOptions) {
    this.group = groupIdForChat(opts.chatId);
  }

  async getLimitStatus(member: Member): Promise<LimitStatus> {
    const wallet = walletOf(member);
    if (!wallet) return { limit: { ...member.limit, amount: micros(0) }, remaining: micros(0) };

    const [[active, period, limit], remaining, resetsAt] = await Promise.all([
      this.read("members", [this.group, wallet]),
      this.read("remaining", [this.group, wallet]),
      this.read("resetsAt", [this.group, wallet]),
    ]);
    const periodName = period === 0 ? "weekly" : "monthly";
    if (!active) return { limit: { amount: micros(0), period: periodName }, remaining: micros(0) };
    const resetsAtMs = Number(resetsAt) * 1000;
    return {
      limit: { amount: micros(limit), period: periodName, resetsAt: resetsAtMs },
      remaining: micros(remaining),
      resetsAt: resetsAtMs,
    };
  }

  async canPull(member: Member, amount: Usdc): Promise<{ ok: boolean; remaining: Usdc }> {
    const { remaining } = await this.getLimitStatus(member);
    return { ok: amount <= remaining, remaining };
  }

  async pull(params: PullParams): Promise<PullOutcome> {
    const id = pullSpendId(this.opts.chatId, params.idempotencyKey);
    const done = this.settled.get(id);
    if (done) return done;
    const running = this.inFlight.get(id);
    if (running) return running;

    const attempt = this.pullOnce(id, params).catch(
      (err: unknown): PullOutcome => ({ status: "failed", reason: `Arc error: ${shortError(err)}` }),
    );
    this.inFlight.set(id, attempt);
    try {
      const outcome = await attempt;
      // Only onchain results are final; "no wallet yet" and RPC errors can change on a retry.
      if (outcome.txRef) this.settled.set(id, outcome);
      return outcome;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async pullOnce(id: Hex, params: PullParams): Promise<PullOutcome> {
    const from = walletOf(params.from);
    if (!from) return { status: "failed", reason: "hasn't linked a wallet yet" };
    if (params.to.kind !== "wallet" || !isAddress(params.to.address)) {
      return { status: "failed", reason: "payer hasn't linked a wallet yet" };
    }
    const to = getAddress(params.to.address);
    if (from === to) return { status: "failed", reason: "payer and member share a wallet" };
    if (params.amount <= 0n) return { status: "pulled" };

    let [status] = await this.read("getSpend", [id]);

    if (status === SpendStatus.None) {
      const [active] = await this.read("members", [this.group, from]);
      if (!active) return { status: "failed", reason: "hasn't joined this chat's treasury" };
      const deadline = BigInt(Math.floor(Date.now() / 1000) + (this.opts.approvalWindowSeconds ?? 3600));
      await this.write("propose", [id, this.group, to, [from], [params.amount], deadline]);
      status = SpendStatus.Proposed;
    }

    if (status === SpendStatus.Cancelled) return { status: "failed", reason: "cancelled" };
    if (status === SpendStatus.Settled) return this.settledOutcome(id);

    if (!(await this.read("approved", [id, from]))) {
      await this.write("approveFor", [id, from]);
    }
    const receipt = await this.write("settle", [id]);
    return outcomeFromLogs(id, receipt.logs) ?? { status: "failed", reason: "settled without a pull event" };
  }

  /**
   * Recovers the outcome of a pull that settled on an earlier attempt (e.g. before a restart).
   * Scans backwards from the newest block in small windows: the public Arc RPC rejects large
   * `eth_getLogs` ranges, and a retried pull almost always settled recently.
   */
  private async settledOutcome(id: Hex): Promise<PullOutcome> {
    const client = this.opts.publicClient;
    const floor = this.opts.deployBlock ?? 0n;
    let to = await client.getBlockNumber({ cacheTime: 0 });
    for (let window = 0; window < LOG_WINDOWS && to >= floor; window++) {
      const from = to - LOG_WINDOW_BLOCKS + 1n > floor ? to - LOG_WINDOW_BLOCKS + 1n : floor;
      const query = { address: this.opts.treasury, abi: groupTreasuryAbi, args: { id }, fromBlock: from, toBlock: to };
      const [pulled, failed] = await Promise.all([
        client.getContractEvents({ ...query, eventName: "SharePulled" }),
        client.getContractEvents({ ...query, eventName: "PullFailed" }),
      ]);
      const outcome = outcomeFromLogs(id, [...pulled, ...failed]);
      if (outcome) return outcome;
      to = from - 1n;
    }
    return { status: "failed", reason: "settled, but its pull event wasn't found" };
  }

  private read<F extends ReadFn>(functionName: F, args: ReadArgs<F>) {
    // viem can't narrow `args` through a generic function name; the public signature keeps callers typed.
    return this.opts.publicClient.readContract({
      address: this.opts.treasury,
      abi: groupTreasuryAbi,
      functionName,
      args,
    } as never) as Promise<ReadResult<F>>;
  }

  private async write<F extends WriteFn>(functionName: F, args: WriteArgs<F>) {
    const { walletClient, publicClient, treasury } = this.opts;
    const hash = await walletClient.writeContract({
      address: treasury,
      abi: groupTreasuryAbi,
      functionName,
      args,
      account: walletClient.account,
      chain: walletClient.chain,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }
}

type Abi = typeof groupTreasuryAbi;
type Fn = Extract<Abi[number], { type: "function" }>;
type ReadFn = Extract<Fn, { stateMutability: "view" }>["name"];
type WriteFn = Extract<Fn, { stateMutability: "nonpayable" }>["name"];
type ReadArgs<F extends ReadFn> = import("viem").ContractFunctionArgs<Abi, "view", F>;
type ReadResult<F extends ReadFn> = import("viem").ContractFunctionReturnType<Abi, "view", F>;
type WriteArgs<F extends WriteFn> = import("viem").ContractFunctionArgs<Abi, "nonpayable", F>;

function walletOf(member: Member): Address | undefined {
  const address = member.wallet?.address;
  return address && isAddress(address) ? getAddress(address) : undefined;
}

function outcomeFromLogs(id: Hex, logs: Parameters<typeof parseEventLogs>[0]["logs"]): PullOutcome | undefined {
  const events = parseEventLogs({ abi: groupTreasuryAbi, logs, eventName: ["SharePulled", "PullFailed"] });
  const mine = events.find((e) => e.args.id === id);
  if (!mine) return undefined;
  if (mine.eventName === "SharePulled") return { status: "pulled", txRef: mine.transactionHash ?? undefined };
  return { status: "failed", reason: mine.args.reason, txRef: mine.transactionHash ?? undefined };
}

function shortError(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

export interface ArcEnv {
  rpcUrl?: string;
  operatorPrivateKey: Hex;
  treasury: Address;
  deployBlock?: bigint;
}

/**
 * Builds one adapter per chat that share an RPC connection and the operator's nonce manager, so
 * pulls in different chats don't collide on nonces.
 */
export function arcWalletAdapters(env: ArcEnv, chain: Chain = arcTestnet): (chatId: string) => ArcWalletAdapter {
  const transport = http(env.rpcUrl);
  const account = privateKeyToAccount(env.operatorPrivateKey, { nonceManager });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const byChat = new Map<string, ArcWalletAdapter>();
  return (chatId) => {
    let adapter = byChat.get(chatId);
    if (!adapter) {
      adapter = new ArcWalletAdapter({
        treasury: getAddress(env.treasury),
        chatId,
        publicClient: publicClient as PublicClient,
        walletClient,
        ...(env.deployBlock !== undefined ? { deployBlock: env.deployBlock } : {}),
      });
      byChat.set(chatId, adapter);
    }
    return adapter;
  };
}
