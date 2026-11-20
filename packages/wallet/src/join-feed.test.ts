import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { JoinWatcher, type DebtPaidEvent, type JoinEvent } from "./join.js";
import { groupTreasuryAbi } from "./treasury-abi.js";

const TREASURY = "0xAF2b75eda3c50358Ce754b93c60F76F0871bE235";
const GROUP = `0x${"a1".repeat(32)}` as Hex;
const ME = "0x1111111111111111111111111111111111111111";
const PAYER = "0x3333333333333333333333333333333333333333";

/** An event the server doesn't act on (not in its ABI): the feed carries it, the watcher skips it. */
const extra = parseAbi(["event SpendCancelled(bytes32 indexed id)"]);

/** A row the way /api/events serves it: raw topics and data, numbers in hex. */
function feedLog(eventName: "Joined" | "DebtPaid" | "SpendCancelled", args: Record<string, unknown>, block: number, logIndex = 0) {
  const event = [...groupTreasuryAbi, ...extra].find((e) => e.type === "event" && e.name === eventName)!;
  if (event.type !== "event") throw new Error("not an event");
  const topics = encodeEventTopics({ abi: [event], eventName, args } as Parameters<typeof encodeEventTopics>[0]);
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
  return { topics, data, transactionHash: `0x${block.toString(16).padStart(64, "0")}`, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${logIndex.toString(16)}` };
}

/** The chain must not be touched while the feed works. */
function chain(head = 500n) {
  const calls: string[] = [];
  const publicClient = {
    getBlockNumber: async () => (calls.push("head"), head),
    getContractEvents: async () => (calls.push("logs"), []),
  } as unknown as PublicClient;
  return { publicClient, calls };
}

function feed(pages: unknown[][], status = 200) {
  const urls: string[] = [];
  const auth: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (status !== 200) return new Response("{}", { status });
    return Response.json({ logs: pages.shift() ?? [] });
  }) as typeof fetch;
  return { fetcher, urls, auth };
}

describe("JoinWatcher with the QuickNode Stream feed", () => {
  it("dispatches joins and debts from the feed in order and moves the cursor past them", async () => {
    const { publicClient, calls } = chain();
    const f = feed([
      [
        feedLog("Joined", { group: GROUP, member: ME, limit: 50_000_000n, period: 0, ticket: GROUP }, 120),
        feedLog("SpendCancelled", { id: GROUP }, 121),
        feedLog("DebtPaid", { debtor: ME, creditor: PAYER, amount: 4_000_000n }, 130),
      ],
    ]);
    const joins: JoinEvent[] = [];
    const debts: DebtPaidEvent[] = [];
    let cursor = 0n;
    const w = new JoinWatcher({
      publicClient,
      treasury: TREASURY,
      fromBlock: 100n,
      feed: { url: "https://kitty.test/api/events", secret: "s3cret", fetcher: f.fetcher },
      onJoin: async (e) => void joins.push(e),
      onDebtPaid: async (e) => void debts.push(e),
      onCursor: (b) => (cursor = b),
    });
    expect(w.source).toBe("stream");
    await w.poll();
    expect(joins).toMatchObject([{ group: GROUP, account: ME, limit: { amount: 50_000_000n, period: "weekly" }, blockNumber: 120n }]);
    expect(debts).toMatchObject([{ debtor: ME, creditor: PAYER, amount: 4_000_000n }]);
    expect(cursor).toBe(131n);
    expect(f.urls[0]).toBe("https://kitty.test/api/events?after=99:999999");
    expect(f.auth[0]).toBe("Bearer s3cret");
    expect(calls).toEqual([]);

    await w.poll(); // nothing new: the cursor stays
    expect(f.urls[1]).toBe("https://kitty.test/api/events?after=130:999999");
    expect(cursor).toBe(131n);
  });

  it("goes back to watching the chain after the feed fails a few times", async () => {
    const { publicClient, calls } = chain();
    const f = feed([], 503);
    const lines: string[] = [];
    const w = new JoinWatcher({
      publicClient,
      treasury: TREASURY,
      fromBlock: 100n,
      feed: { url: "https://kitty.test/api/events", secret: "s", fetcher: f.fetcher, maxFeedFailures: 2 },
      onJoin: async () => {},
      log: (l) => lines.push(l),
    });
    await expect(w.poll()).rejects.toThrow(/503/);
    expect(w.source).toBe("stream");
    await w.poll();
    expect(w.source).toBe("rpc");
    expect(calls).toContain("logs");
    expect(lines.at(-1)).toMatch(/RPC/);
  });
});
