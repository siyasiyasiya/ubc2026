/**
 * Face ID onboarding, server side: invite tickets, the join watcher, and a testnet welcome balance.
 *
 * A ticket is derived, not stored: `keccak256(secret, chatId, handle)`. Only the server knows the
 * secret, so a ticket can't be guessed, and when a `Joined` event arrives the server finds whose
 * it is by recomputing the ticket for that chat's members. No ticket database to keep in sync,
 * and the invite CLI can mint links while the bot is running.
 */

import { formatUsdc, micros, periodFromIndex, type SpendingLimit, type Usdc } from "@gta/core";
import {
  decodeEventLog,
  encodePacked,
  getAddress,
  keccak256,
  type Account,
  type Address,
  type Chain,
  type GetContractEventsReturnType,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { groupIdForChat, LOG_WINDOW_BLOCKS } from "./arc.js";
import { groupTreasuryAbi } from "./treasury-abi.js";

/**
 * The single-use ticket for `handle` joining `chatId`. Keep `secret` server-side. Tickets are used
 * up onchain, so each new invite for the same person (say, after they left or lost their phone)
 * takes the next `nonce`.
 */
export function inviteTicket(secret: string, chatId: string, handle: string, nonce = 0): Hex {
  const parts = [secret, "\n", chatId, "\n", handle, ...(nonce > 0 ? ["\n", String(nonce)] : [])];
  return keccak256(encodePacked(parts.map(() => "string"), parts));
}

export interface InviteLinkInput {
  /** The Face ID page, e.g. https://kittyagent.vercel.app */
  baseUrl: string;
  secret: string;
  chatId: string;
  chatName: string;
  handle: string;
  displayName: string;
  /** Which invite this is for the person (0 for the first). */
  nonce?: number;
  /** Starting limit shown on the page, so joining is one tap with nothing to type. */
  limit?: SpendingLimit;
}

/** The link the agent DMs a member: `?g=<group>&t=<ticket>&c=<chat name>&n=<name>`. */
export function inviteLink(input: InviteLinkInput): string {
  const url = new URL(input.baseUrl);
  url.searchParams.set("g", groupIdForChat(input.chatId));
  url.searchParams.set("t", inviteTicket(input.secret, input.chatId, input.handle, input.nonce ?? 0));
  url.searchParams.set("c", input.chatName);
  if (input.displayName) url.searchParams.set("n", input.displayName);
  if (input.limit) {
    url.searchParams.set("l", formatUsdc(input.limit.amount).slice(1));
    url.searchParams.set("p", input.limit.period);
  }
  return url.toString();
}

/** A `Joined` event from the contract. */
export interface JoinEvent {
  group: Hex;
  account: Address;
  limit: SpendingLimit;
  ticket: Hex;
  blockNumber: bigint;
  txHash: Hex;
}

/** A member's limit changed: by their own Face ID (`by` = account) or lowered by the operator. */
export interface LimitSetEvent {
  group: Hex;
  account: Address;
  limit: SpendingLimit;
  by: Address;
  blockNumber: bigint;
  txHash: Hex;
}

/** A member paid back a share that couldn't be pulled earlier. */
export interface DebtPaidEvent {
  debtor: Address;
  creditor: Address;
  amount: Usdc;
  blockNumber: bigint;
  txHash: Hex;
}

export interface JoinWatcherOptions {
  publicClient: PublicClient;
  treasury: Address;
  /** First block to scan (where the cursor was saved, or the treasury's deploy block). */
  fromBlock: bigint;
  /** Called for each join, in order. The cursor only advances once this resolves. */
  onJoin: (event: JoinEvent) => Promise<void>;
  /** Called for each limit change, in order with the other events. */
  onLimitSet?: (event: LimitSetEvent) => Promise<void>;
  /** Called for each debt paid back, in order with the other events. */
  onDebtPaid?: (event: DebtPaidEvent) => Promise<void>;
  /** Called after each scanned window so the caller can persist where to resume. */
  onCursor?: (nextBlock: bigint) => void;
  /**
   * Read events from Kitty's QuickNode Stream feed (the page's /api/events) instead of polling
   * the chain. After `maxFeedFailures` failed reads in a row the watcher goes back to RPC.
   */
  feed?: { url: string; secret: string; fetcher?: typeof fetch; maxFeedFailures?: number };
  pollMs?: number;
  log?: (line: string) => void;
}

/** One treasury log as /api/events returns it (explorer format: numbers in hex). */
interface FeedLog {
  topics: (Hex | null)[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
  logIndex: Hex;
}

/** Most logs the feed returns per read (api/events.ts). */
const FEED_PAGE = 1000;

/**
 * Polls the treasury for the events the server acts on (`Joined`, `LimitSet`, `DebtPaid`) and hands
 * each to its handler in chain order. One `eth_getLogs` per window covers all of them.
 */
export class JoinWatcher {
  private next: bigint;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private failures = 0;
  private feedFailures = 0;
  private useFeed: boolean;

  constructor(private readonly opts: JoinWatcherOptions) {
    this.next = opts.fromBlock;
    this.useFeed = !!opts.feed;
  }

  /** Where events come from right now. */
  get source(): "stream" | "rpc" {
    return this.useFeed ? "stream" : "rpc";
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Scans everything new once, from the Stream feed or the chain. Exposed for tests and one-off catch-up. */
  async poll(): Promise<void> {
    if (this.useFeed) {
      try {
        await this.pollFeed();
        this.feedFailures = 0;
        return;
      } catch (err) {
        this.feedFailures++;
        const max = this.opts.feed?.maxFeedFailures ?? 3;
        this.opts.log?.(`stream feed: ${(err as Error).message?.split("\n")[0]} (${this.feedFailures}/${max})`);
        if (this.feedFailures < max) throw err;
        this.useFeed = false;
        this.opts.log?.("stream feed: unavailable, watching the chain directly (RPC) instead");
      }
    }
    await this.pollChain();
  }

  /**
   * Reads every treasury event at or after the cursor block from the Stream feed. A block's events
   * arrive in one delivery, so the cursor moves block by block, never through the middle of one.
   */
  private async pollFeed(): Promise<void> {
    const feed = this.opts.feed!;
    const fetcher = feed.fetcher ?? fetch;
    for (;;) {
      const url = `${feed.url}?after=${this.next - 1n}:999999`;
      const res = await fetcher(url, { headers: { authorization: `Bearer ${feed.secret}` } });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      const body = (await res.json()) as { logs?: FeedLog[] };
      if (!Array.isArray(body.logs)) throw new Error("feed reply has no logs");
      const logs = body.logs;
      if (!logs.length) return;
      const full = logs.length >= FEED_PAGE;
      const last = BigInt(logs[logs.length - 1]!.blockNumber);
      // A full page may stop partway through its last block: leave that block for the next read.
      const upTo = full ? last - 1n : last;
      for (const raw of logs) {
        if (BigInt(raw.blockNumber) > upTo) break;
        const log = decodeFeedLog(raw);
        if (log) await this.dispatch(log);
      }
      if (upTo >= this.next) {
        this.next = upTo + 1n;
        this.opts.onCursor?.(this.next);
      }
      if (!full) return;
    }
  }

  private async pollChain(): Promise<void> {
    const head = await this.opts.publicClient.getBlockNumber({ cacheTime: 0 });
    while (this.next <= head) {
      const to = this.next + LOG_WINDOW_BLOCKS - 1n < head ? this.next + LOG_WINDOW_BLOCKS - 1n : head;
      const logs = await this.opts.publicClient.getContractEvents({
        address: this.opts.treasury,
        abi: groupTreasuryAbi,
        fromBlock: this.next,
        toBlock: to,
      });
      for (const log of logs) await this.dispatch(log);
      this.next = to + 1n;
      this.opts.onCursor?.(this.next);
    }
  }

  private async dispatch(log: TreasuryLog): Promise<void> {
    const at = { blockNumber: log.blockNumber, txHash: log.transactionHash };
    if (log.eventName === "Joined") {
      const { group, member, limit, period, ticket } = log.args;
      if (!group || !member || limit === undefined || period === undefined || !ticket) return;
      await this.opts.onJoin({ group, account: getAddress(member), limit: limitOf(limit, period), ticket, ...at });
    } else if (log.eventName === "LimitSet" && this.opts.onLimitSet) {
      const { group, member, limit, period, by } = log.args;
      if (!group || !member || limit === undefined || period === undefined || !by) return;
      await this.opts.onLimitSet({ group, account: getAddress(member), limit: limitOf(limit, period), by: getAddress(by), ...at });
    } else if (log.eventName === "DebtPaid" && this.opts.onDebtPaid) {
      const { debtor, creditor, amount } = log.args;
      if (!debtor || !creditor || amount === undefined) return;
      await this.opts.onDebtPaid({ debtor: getAddress(debtor), creditor: getAddress(creditor), amount: micros(amount), ...at });
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    let delay = this.opts.pollMs ?? 4_000;
    try {
      await this.poll();
      this.failures = 0;
    } catch (err) {
      // Rate limits and flaky RPCs: back off, then resume from the same cursor.
      this.failures++;
      delay = Math.min(60_000, delay * 2 ** this.failures);
      this.opts.log?.(`join watcher: ${(err as Error).message?.split("\n")[0]} (retrying in ${delay / 1000}s)`);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), delay);
  }
}

type TreasuryLog = GetContractEventsReturnType<typeof groupTreasuryAbi>[number];

/** A feed row decoded like `getContractEvents` would, or undefined for a log this ABI doesn't know. */
function decodeFeedLog(raw: FeedLog): TreasuryLog | undefined {
  try {
    const topics = raw.topics.filter((t): t is Hex => !!t) as [Hex, ...Hex[]];
    const { eventName, args } = decodeEventLog({ abi: groupTreasuryAbi, topics, data: raw.data });
    // dispatch() reads only these fields; the rest of viem's log shape doesn't apply to feed rows.
    return { eventName, args, blockNumber: BigInt(raw.blockNumber), transactionHash: raw.transactionHash } as unknown as TreasuryLog;
  } catch {
    return undefined;
  }
}

function limitOf(limit: bigint, period: number): SpendingLimit {
  return { amount: micros(limit), period: periodFromIndex(period) };
}

/**
 * Testnet only: sends a new member a small welcome balance from the operator wallet so the demo
 * works before they add money. (Circle's faucet API isn't enabled for our key; the web faucet at
 * faucet.circle.com tops up the operator.) In production, members add money through Arc Onramp
 * and this is never called. USDC is Arc's native currency, so this is a plain value transfer
 * (18 decimals natively, hence the 10^12 scale from 6-decimal USDC).
 */
export async function sendWelcomeBalance(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: PublicClient,
  to: Address,
  amount: Usdc,
): Promise<Hex> {
  const hash = await walletClient.sendTransaction({ to, value: amount * 10n ** 12n });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
