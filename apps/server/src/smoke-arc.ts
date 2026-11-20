/**
 * Live smoke test of auto pay-back and all-or-nothing group buys against the deployed
 * GroupTreasury on Arc testnet, through the bot's real `ArcWalletAdapter`.
 *
 *   pnpm --filter @gta/server smoke-arc
 *
 * Makes three throwaway wallets (Alice, Bob, Carol), funds each with a few test dollars from the
 * operator, joins them to a fresh test group, then checks every step against the chain. Needs
 * ARC_RPC_URL, TREASURY_ADDRESS, OPERATOR_PRIVATE_KEY (the same .env the bot uses). Exits 1 on
 * the first failed check. Costs about $12 of testnet USDC per run (mostly left in the throwaway wallets).
 */
import { micros, type Member } from "@gta/core";
import { arcClients, ArcWalletAdapter, groupIdForChat, groupTreasuryAbi, poolIdFor } from "@gta/wallet";
import { createWalletClient, erc20Abi, getAddress, http, keccak256, parseEther, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const treasury = getAddress(process.env.TREASURY_ADDRESS ?? "");
const env = { rpcUrl: process.env.ARC_RPC_URL, operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY as Hex, treasury };
const { publicClient, walletClient: operator } = arcClients(env);
const chatId = `smoke:${Date.now()}`;
const group = groupIdForChat(chatId);
const adapter = new ArcWalletAdapter({ treasury, chatId, publicClient, walletClient: operator, approvalWindowSeconds: 600 });
const usd = (n: number) => micros(BigInt(Math.round(n * 1e6)));
const fmt = (n: bigint) => `$${(Number(n) / 1e6).toFixed(2)}`;
const tx = (h?: string) => (h ? ` https://testnet.arcscan.app/tx/${h}` : "");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

interface Person {
  member: Member;
  address: Address;
  wallet: ReturnType<typeof createWalletClient>;
}

async function person(name: string): Promise<Person> {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(env.rpcUrl) });
  // USDC is Arc's native gas token (18 decimals); the same money shows up through the ERC-20 at 6.
  const hash = await operator.sendTransaction({ to: account.address, value: parseEther("4") });
  await publicClient.waitForTransactionReceipt({ hash });
  const usdcAddress = (await publicClient.readContract({ address: treasury, abi: groupTreasuryAbi, functionName: "usdc" })) as Address;
  await send(wallet, usdcAddress, erc20Abi, "approve", [treasury, 2n ** 255n]);
  const ticket = keccak256(toBytes(`${chatId}:${name}`));
  await send(wallet, treasury, joinAbi, "join", [group, usd(5), 0, ticket]);
  console.log(`   ${name}: ${account.address}`);
  return {
    address: account.address,
    wallet,
    member: { id: name, displayName: name, handle: { kind: "email", value: `${name}@smoke.test` }, wallet: { address: account.address }, limit: { amount: usd(5), period: "weekly" } },
  };
}

const joinAbi = [
  { type: "function", name: "join", stateMutability: "nonpayable", inputs: [{ name: "group", type: "bytes32" }, { name: "limit", type: "uint128" }, { name: "period", type: "uint8" }, { name: "ticket", type: "bytes32" }], outputs: [] },
  { type: "function", name: "setLimit", stateMutability: "nonpayable", inputs: [{ name: "group", type: "bytes32" }, { name: "limit", type: "uint128" }, { name: "period", type: "uint8" }], outputs: [] },
] as const;

// viem can't narrow a generic function name through this helper; each call site passes a matching ABI entry.
async function send(wallet: ReturnType<typeof createWalletClient>, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account!, chain: arcTestnet } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
}

async function balance(p: Person | Address): Promise<bigint> {
  const address = typeof p === "string" ? p : p.address;
  return adapter.balance({ id: "x", displayName: "x", handle: { kind: "email", value: "x@smoke.test" }, wallet: { address }, limit: { amount: usd(0), period: "weekly" } });
}

const remaining = async (p: Person) => (await adapter.getLimitStatus(p.member)).remaining;

async function main(): Promise<void> {
  console.log(`GroupTreasury ${treasury} on Arc testnet, test group "${chatId}"`);
  const [alice, bob, carol] = [await person("Alice"), await person("Bob"), await person("Carol")];

  console.log("\n— All-or-nothing group buy (Alice buys, 2 people at $1 each) —");
  const deadline = Date.now() + 10 * 60_000;
  await adapter.openPool({ poolId: "tickets", payee: alice.member, each: usd(1), needed: 2, deadline });
  const aliceBefore = await balance(alice);
  const first = await adapter.pledge("tickets", bob.member);
  check("Bob's pledge is held, not paid out", first.status === "pledged" && first.count === 1 && !first.filled, JSON.stringify(first) + tx(first.status === "pledged" ? first.txRef : undefined));
  check("the $1 sits in the contract", (await balance(treasury)) === usd(1), fmt(await balance(treasury)));
  check("Alice hasn't been paid yet", (await balance(alice)) === aliceBefore);
  check("Bob's limit already counts it", (await remaining(bob)) === usd(4), fmt(await remaining(bob)));
  const twice = await adapter.pledge("tickets", bob.member);
  check("Bob pledging twice is refused with a plain reason", twice.status === "failed" && twice.reason === "already in", JSON.stringify(twice));
  const second = await adapter.pledge("tickets", carol.member);
  check("Carol's pledge fills it", second.status === "pledged" && second.count === 2 && second.filled, JSON.stringify(second) + tx(second.status === "pledged" ? second.txRef : undefined));
  check("the $2 pot went to Alice in the same transaction", (await balance(alice)) - aliceBefore === usd(2), fmt((await balance(alice)) - aliceBefore));
  check("nothing left in the contract", (await balance(treasury)) === usd(0), fmt(await balance(treasury)));
  const late = await adapter.pledge("tickets", alice.member);
  check("pledging to a filled buy is refused", late.status === "failed" && late.reason === "this buy is closed", JSON.stringify(late));

  console.log("\n— Over the limit —");
  await adapter.openPool({ poolId: "cabin", payee: alice.member, each: usd(4.5), needed: 2, deadline });
  const over = await adapter.pledge("cabin", bob.member);
  check("Bob ($4 left of $5) can't pledge $4.50", over.status === "failed" && over.reason === "over their limit here", JSON.stringify(over));

  console.log("\n— Called off: everyone gets it back —");
  await adapter.openPool({ poolId: "boat", payee: alice.member, each: usd(0.5), needed: 3, deadline });
  const carolBefore = await balance(carol);
  const carolLeft = await remaining(carol);
  const held = await adapter.pledge("boat", carol.member);
  check("Carol pledges $0.50", held.status === "pledged" && !held.filled, JSON.stringify(held));
  await adapter.refundPool("boat");
  const [status] = (await publicClient.readContract({ address: treasury, abi: groupTreasuryAbi, functionName: "getPool", args: [poolIdFor(chatId, "boat")] })) as readonly [number, ...unknown[]];
  check("the buy is marked refunded onchain", status === 3, `status ${status}`);
  check("Carol has her $0.50 back", (await balance(carol)) === carolBefore, `${fmt(carolBefore)} → ${fmt(await balance(carol))}`);
  check("and her limit back", (await remaining(carol)) === carolLeft, fmt(await remaining(carol)));

  console.log("\n— Auto pay-back —");
  // Bob owes Alice $0.75: a share over his limit becomes a debt.
  await send(bob.wallet, treasury, joinAbi, "setLimit", [group, 0n, 0]);
  const failed = await adapter.pull({ from: bob.member, to: { kind: "wallet", address: alice.address }, amount: usd(0.75), idempotencyKey: "bob-owes-alice" });
  check("Bob's over-limit share becomes a debt", failed.status === "failed" && (await adapter.owed(bob.member, alice.member)) === usd(0.75), `${failed.reason}, owed ${fmt(await adapter.owed(bob.member, alice.member))}`);
  await send(bob.wallet, treasury, joinAbi, "setLimit", [group, usd(5), 0]);

  // Carol pays Bob $1: $0.75 should go straight to Alice, $0.25 to Bob.
  const [a0, b0] = [await balance(alice), await balance(bob)];
  const paid = await adapter.pull({ from: carol.member, to: { kind: "wallet", address: bob.address }, amount: usd(1), idempotencyKey: "carol-pays-bob" });
  check("Carol's $1 share to Bob is pulled", paid.status === "pulled", JSON.stringify({ ...paid, autoPaid: undefined }) + tx(paid.txRef));
  const auto = paid.autoPaid ?? [];
  check("the adapter reports $0.75 auto-paid to Alice", auto.length === 1 && auto[0]!.creditor === alice.address && auto[0]!.amount === usd(0.75), JSON.stringify(auto, (_k, v) => (typeof v === "bigint" ? fmt(v) : v)));
  check("Alice got $0.75", (await balance(alice)) - a0 === usd(0.75), fmt((await balance(alice)) - a0));
  check("Bob got the other $0.25", (await balance(bob)) - b0 === usd(0.25), fmt((await balance(bob)) - b0));
  check("Bob's debt to Alice is cleared", (await adapter.owed(bob.member, alice.member)) === usd(0));
  const plain = await adapter.pull({ from: carol.member, to: { kind: "wallet", address: bob.address }, amount: usd(0.25), idempotencyKey: "carol-pays-bob-again" });
  check("with no debts left, the next share goes straight to Bob", plain.status === "pulled" && !plain.autoPaid, JSON.stringify(plain));

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

