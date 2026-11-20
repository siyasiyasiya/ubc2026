import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe as suite, expect, it } from "vitest";
import { treasuryEvents } from "../src/abi";
import { describe, describePurchase, money, plain } from "../src/dashboard";
import { allowedQuery } from "../api/explorer";
import { buildHistory, loadHistory, type ExplorerLog, type ExplorerTransfer } from "../src/history";

const ME = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const KITTY = "0x4444444444444444444444444444444444444444";
const FAUCET = "0x5555555555555555555555555555555555555555";
const SKI = `0x${"a1".repeat(32)}` as Hex;
const RENT = `0x${"b2".repeat(32)}` as Hex;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "f")}` as Hex;
const $ = (usd: number) => BigInt(Math.round(usd * 100)) * 10_000n;

let block = 100;
/** One treasury log the way Arcscan returns it: indexed args as topics, the rest ABI-encoded. */
function log(eventName: (typeof treasuryEvents)[number]["name"], args: Record<string, unknown>, hash: Hex, at = 1_000): ExplorerLog {
  const event = treasuryEvents.find((e) => e.name === eventName)!;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as Parameters<typeof encodeEventTopics>[0]);
  const plainInputs = event.inputs.filter((i) => !("indexed" in i && i.indexed));
  const data = encodeAbiParameters(plainInputs, plainInputs.map((i) => args[i.name!]));
  block += 1;
  return { topics: [...(topics as Hex[]), null], data, transactionHash: hash, timeStamp: `0x${at.toString(16)}`, blockNumber: `0x${block.toString(16)}`, logIndex: "0x0" };
}

function transfer(hash: Hex, from: string, to: string, amount: bigint, at = 1_000): ExplorerTransfer {
  return { hash, from, to, value: amount.toString(), timeStamp: String(at) };
}

function fixture() {
  const logs = [
    log("Joined", { group: SKI, member: ME, limit: $(200), period: 0, ticket: id(900) }, tx(1), 1_000),
    log("Joined", { group: SKI, member: BOB, limit: $(100), period: 0, ticket: id(901) }, tx(2), 1_010),
    log("Joined", { group: RENT, member: BOB, limit: $(500), period: 1, ticket: id(902) }, tx(3), 1_020),
    log("LimitSet", { group: SKI, member: ME, limit: $(50), period: 0, by: KITTY }, tx(4), 1_030),
    // Purchase 1: both paid.
    log("SpendProposed", { id: id(1), group: SKI, payee: PAYER, total: $(30), deadline: 9_999n }, tx(5), 1_100),
    log("SpendApproved", { id: id(1), member: ME }, tx(6), 1_110),
    log("SpendApproved", { id: id(1), member: BOB }, tx(7), 1_120),
    log("SharePulled", { id: id(1), from: ME, to: PAYER, amount: $(15) }, tx(8), 1_130),
    log("SharePulled", { id: id(1), from: BOB, to: PAYER, amount: $(15) }, tx(8), 1_130),
    log("SpendSettled", { id: id(1), pulled: $(30), owed: 0n }, tx(8), 1_130),
    // Purchase 2: my share couldn't move.
    log("SpendProposed", { id: id(2), group: SKI, payee: PAYER, total: $(8), deadline: 9_999n }, tx(9), 1_200),
    log("PullFailed", { id: id(2), from: ME, to: PAYER, amount: $(4), reason: "transfer failed" }, tx(10), 1_210),
    log("SharePulled", { id: id(2), from: BOB, to: PAYER, amount: $(4) }, tx(10), 1_210),
    log("SpendSettled", { id: id(2), pulled: $(4), owed: $(4) }, tx(10), 1_210),
    // Purchase 3: cancelled. Purchase 4: still waiting, paid to me.
    log("SpendProposed", { id: id(3), group: SKI, payee: PAYER, total: $(99), deadline: 9_999n }, tx(11), 1_300),
    log("SpendCancelled", { id: id(3) }, tx(12), 1_310),
    log("SpendProposed", { id: id(4), group: SKI, payee: ME, total: $(20), deadline: 9_999n }, tx(13), 1_400),
    // I paid my missed share back.
    log("DebtPaid", { debtor: ME, creditor: PAYER, amount: $(4) }, tx(14), 1_500),
    log("Left", { group: SKI, member: BOB, by: BOB }, tx(15), 1_600),
  ];
  const transfers = [
    transfer(tx(20), FAUCET, ME, $(20), 1_050),
    transfer(tx(8), ME, PAYER, $(15), 1_130),
    transfer(tx(8), BOB, PAYER, $(15), 1_130), // not mine: ignored
    transfer(tx(14), ME, PAYER, $(4), 1_500),
    transfer(tx(21), ME, BOB, $(2), 1_700),
  ];
  return buildHistory(logs, transfers, ME);
}

suite("buildHistory", () => {
  it("groups purchases by kitty, newest first, with this member's part", () => {
    const h = fixture();
    const ski = h.kitties.get(SKI)!;
    expect(ski.purchases.map((p) => [p.id, p.status])).toEqual([
      [id(4), "waiting"],
      [id(3), "cancelled"],
      [id(2), "paid"],
      [id(1), "paid"],
    ]);
    expect(ski.purchases[3]).toMatchObject({ approvals: 2, pulled: $(30), owed: 0n, mine: { amount: $(15), ok: true } });
    expect(ski.purchases[2]).toMatchObject({ pulled: $(4), owed: $(4), mine: { amount: $(4), ok: false, reason: "transfer failed" } });
    expect(ski.purchases[1].mine).toBeUndefined();
    expect(ski.spent).toBe($(34));
    // Bob left: only I'm still in Ski.
    expect(ski.members).toBe(1);
    expect(h.kitties.get(RENT)!.members).toBe(1);
  });

  it("lists only the kitties this account joined", () => {
    expect(fixture().joined).toEqual([SKI]);
  });

  it("labels each dollar in or out of the account, newest first", () => {
    const h = fixture();
    expect(h.activity.map((e) => [e.kind, e.amount ?? null])).toEqual([
      ["sent", -$(2)],
      ["repaid", -$(4)],
      ["owe", $(4)],
      ["share", -$(15)],
      ["added", $(20)],
      ["limit", null],
      ["joined", null],
    ]);
    const share = h.activity.find((e) => e.kind === "share")!;
    expect(share.group).toBe(SKI);
    expect(h.activity.find((e) => e.kind === "limit")).toMatchObject({ byKitty: true, limit: $(50) });
  });

  it("counts money paid to this member as incoming", () => {
    const logs = [
      log("SpendProposed", { id: id(7), group: SKI, payee: ME, total: $(10), deadline: 9_999n }, tx(30)),
      log("SharePulled", { id: id(7), from: BOB, to: ME, amount: $(10) }, tx(31)),
      log("SpendSettled", { id: id(7), pulled: $(10), owed: 0n }, tx(31)),
    ];
    const h = buildHistory(logs, [transfer(tx(31), BOB, ME, $(10))], ME);
    expect(h.activity).toMatchObject([{ kind: "got", amount: $(10), group: SKI }]);
    expect(h.kitties.get(SKI)!.purchases[0].toMe).toBe($(10));
  });

  it("matches addresses regardless of checksum case", () => {
    const upper = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // a valid checksum
    const logs = [log("Joined", { group: SKI, member: upper, limit: $(5), period: 2, ticket: id(1) }, tx(40))];
    expect(buildHistory(logs, [], upper.toLowerCase()).joined).toEqual([SKI]);
  });

  it("skips logs it can't decode", () => {
    const junk: ExplorerLog = { topics: [id(123), null], data: "0x", transactionHash: tx(50), timeStamp: "0x1", blockNumber: "0x1", logIndex: "0x0" };
    expect(buildHistory([junk], [], ME).activity).toEqual([]);
  });
});

suite("loadHistory", () => {
  it("reads the treasury's logs and the account's USDC transfers, and treats 'no records' as empty", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const body = url.includes("getLogs")
        ? { status: "1", message: "OK", result: [log("Joined", { group: SKI, member: ME, limit: $(5), period: 0, ticket: id(1) }, tx(60))] }
        : { status: "0", message: "No token transfers found", result: [] as unknown[] };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const h = await loadHistory(KITTY, ME, { fetcher });
    expect(h.joined).toEqual([SKI]);
    expect(urls.some((u) => u.includes(`address=${KITTY}`) && u.includes("action=getLogs"))).toBe(true);
    expect(urls.some((u) => u.includes(`address=${ME}`) && u.includes("action=tokentx"))).toBe(true);
  });

  it("retries when the explorer is busy, then fails loudly so the page can offer a retry", async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: "0", message: "Too many requests", result: null }), { status: 429 });
    }) as unknown as typeof fetch;
    await expect(loadHistory(KITTY, ME, { fetcher, wait: async (ms) => void waits.push(ms) })).rejects.toThrow(/429/);
    expect(calls).toBe(12); // two endpoints, proxy then explorer, three tries each
    expect(waits).toHaveLength(8);
  });

  it("still shows purchases and shares when only the transfer list fails", async () => {
    const fetcher = (async (url: string) => {
      if (url.includes("tokentx")) return new Response("{}", { status: 500 });
      const logs = [
        log("SpendProposed", { id: id(8), group: SKI, payee: PAYER, total: $(10), deadline: 9_999n }, tx(70)),
        log("SharePulled", { id: id(8), from: ME, to: PAYER, amount: $(5) }, tx(71)),
      ];
      return new Response(JSON.stringify({ status: "1", message: "OK", result: logs }));
    }) as typeof fetch;
    const h = await loadHistory(KITTY, ME, { fetcher, wait: async () => {} });
    expect(h.partial).toBe(true);
    expect(h.activity).toMatchObject([{ kind: "share", amount: -$(5), group: SKI }]);
  });

  it("gets through after one busy reply", async () => {
    let busy = true;
    const fetcher = (async (url: string) => {
      if (busy && url.includes("getLogs")) {
        busy = false;
        return new Response("{}", { status: 429 });
      }
      return new Response(JSON.stringify({ status: "0", message: "No records found", result: [] }));
    }) as typeof fetch;
    await expect(loadHistory(KITTY, ME, { fetcher, wait: async () => {} })).resolves.toMatchObject({ joined: [] });
  });

  it("asks the cached proxy first and falls back to the explorer when there is no proxy", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.startsWith("/api/explorer")) return new Response("<!doctype html>", { status: 200 });
      return new Response(JSON.stringify({ status: "0", message: "No records found", result: [] }));
    }) as typeof fetch;
    await loadHistory(KITTY, ME, { fetcher });
    expect(urls.filter((u) => u.startsWith("/api/explorer"))).toHaveLength(2);
    expect(urls.filter((u) => u.startsWith("https://explorer.testnet.arc.io/api?"))).toHaveLength(2);
  });
});

suite("api/explorer", () => {
  it("forwards only the page's two queries", () => {
    const ok = allowedQuery(new URLSearchParams({ module: "logs", action: "getLogs", address: KITTY, page: "1", offset: "1000" }));
    expect(ok?.get("toBlock")).toBe("latest");
    const transfers = allowedQuery(new URLSearchParams({ module: "account", action: "tokentx", address: ME, contractaddress: "0xevil" }));
    expect(transfers?.get("contractaddress")).toBe("0x3600000000000000000000000000000000000000");
    expect(allowedQuery(new URLSearchParams({ module: "account", action: "balance", address: ME }))).toBeUndefined();
    expect(allowedQuery(new URLSearchParams({ module: "logs", action: "getLogs", address: "nope" }))).toBeUndefined();
    expect(allowedQuery(new URLSearchParams({ module: "logs", action: "getLogs", address: ME, page: "999" }))).toBeUndefined();
  });
});

suite("formatting", () => {
  it("shows money in whole cents without floats", () => {
    expect(money($(1234.5))).toBe("$1,234.50");
    expect(money(-$(15))).toBe("-$15.00");
    expect(money($(12), true)).toBe("$12");
    expect(money(33_549_667n)).toBe("$33.55");
    expect(plain($(80))).toBe("80");
    expect(plain(4_005_000n)).toBe("4.01");
  });

  it("describes activity in plain words", () => {
    const name = () => "Ski trip";
    expect(describe({ kind: "share", at: 1, tx: tx(1), amount: -$(15), group: SKI }, name)).toMatchObject({ title: "Your share", detail: "Ski trip", amount: "-$15.00" });
    expect(describe({ kind: "added", at: 1, tx: tx(1), amount: $(20) }, name)).toMatchObject({ amount: "+$20.00", tone: "in" });
    expect(describe({ kind: "owe", at: 1, tx: tx(1), amount: $(4), group: SKI, reason: "over limit" }, name).detail).toBe("Ski trip · it was over your cap");
    expect(describe({ kind: "limit", at: 1, tx: tx(1), group: SKI, limit: $(50), period: 1, byKitty: true }, name)).toMatchObject({ title: "Kitty lowered your cap", detail: "Ski trip · $50 per month" });
  });

  it("describes a purchase from this member's side", () => {
    const h = fixture();
    const [waiting, cancelled, missed, paid] = h.kitties.get(SKI)!.purchases;
    expect(describePurchase(paid, ME)).toMatchObject({ detail: "$30.00 total · Paid", amount: "-$15.00" });
    expect(describePurchase(missed, ME)).toMatchObject({ detail: "$8.00 total · $4.00 still owed", amount: "$4.00 owed", tone: "owe" });
    expect(describePurchase(cancelled, ME)).toMatchObject({ detail: "$99.00 total · Cancelled", amount: "" });
    expect(describePurchase(waiting, ME).detail).toBe("$20.00 total · Waiting for 👍s · paid to you");
  });
});
