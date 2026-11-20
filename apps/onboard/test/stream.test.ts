import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { logOut, rowsFrom, transferOut, validSignature } from "../api/_kitty-db";
import { treasuryEvents } from "../src/abi";
import { buildHistory, type ExplorerLog, type ExplorerTransfer } from "../src/history";

const TREASURY = "0xAF2b75eda3c50358Ce754b93c60F76F0871bE235";
const USDC = "0x3600000000000000000000000000000000000000";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ME = "0x1111111111111111111111111111111111111111";
const PAYER = "0x3333333333333333333333333333333333333333";
const SKI = `0x${"a1".repeat(32)}` as Hex;
const ID = `0x${"01".padStart(64, "0")}` as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;
const OTHER_TX = `0x${"cd".repeat(32)}` as Hex;

/** The filter exactly as QuickNode runs it: plain JS with a `main`, treasury address substituted. */
type Filter = (stream: { data: unknown; metadata?: unknown }) => { logs: ExplorerLog[]; transfers: ExplorerTransfer[] } | null;
const source = readFileSync(join(__dirname, "../streams/filter.js"), "utf8").replaceAll("__TREASURY__", TREASURY);
const main = new Function(`${source}\nreturn main;`)() as Filter;

function treasuryLog(eventName: (typeof treasuryEvents)[number]["name"], args: Record<string, unknown>, logIndex: number) {
  const event = treasuryEvents.find((e) => e.name === eventName)!;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as Parameters<typeof encodeEventTopics>[0]);
  const plainInputs = event.inputs.filter((i) => !("indexed" in i && i.indexed));
  const data = encodeAbiParameters(plainInputs, plainInputs.map((i) => args[i.name!]));
  return { address: TREASURY, topics, data, logIndex: `0x${logIndex.toString(16)}`, transactionHash: TX, blockNumber: "0x45b9d1c" };
}

function usdcTransfer(from: string, to: string, amount: bigint, logIndex: number, transactionHash = TX) {
  return {
    address: USDC,
    topics: [TRANSFER, pad(from as Hex), pad(to as Hex)],
    data: pad(`0x${amount.toString(16)}`),
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash,
    blockNumber: "0x45b9d1c",
  };
}

/** A block_with_receipts block: one settle tx (treasury + USDC logs), one unrelated USDC transfer. */
function block() {
  return {
    block: { number: "0x45b9d1c", timestamp: "0x6920a000" },
    receipts: [
      {
        transactionHash: TX,
        logs: [
          usdcTransfer(ME, PAYER, 15_000_000n, 0),
          treasuryLog("SharePulled", { id: ID, from: ME, to: PAYER, amount: 15_000_000n }, 1),
          treasuryLog("SpendProposed", { id: ID, group: SKI, payee: PAYER, total: 15_000_000n, deadline: 9_999n }, 2),
          treasuryLog("SpendSettled", { id: ID, pulled: 15_000_000n, owed: 0n }, 3),
        ],
      },
      { transactionHash: OTHER_TX, logs: [usdcTransfer(ME, PAYER, 1n, 0, OTHER_TX)] },
    ],
  };
}

describe("streams/filter.js", () => {
  it("keeps treasury logs and the USDC transfers in the same transaction, in explorer format", () => {
    const out = main({ data: [block()] })!;
    expect(out.logs).toHaveLength(3);
    expect(out.logs[0]).toMatchObject({ transactionHash: TX, timeStamp: "0x6920a000", blockNumber: "0x45b9d1c", logIndex: "0x1" });
    expect(out.transfers).toEqual([
      { hash: TX, from: ME, to: PAYER.toLowerCase(), value: "15000000", timeStamp: String(0x6920a000), blockNumber: String(0x45b9d1c), logIndex: "0" },
    ]);
  });

  it("skips blocks with nothing of Kitty's", () => {
    const quiet = { block: { number: "0x1", timestamp: "0x1" }, receipts: [{ transactionHash: OTHER_TX, logs: [usdcTransfer(ME, PAYER, 1n, 0, OTHER_TX)] }] };
    expect(main({ data: [quiet] })).toBeNull();
    expect(main({ data: [] })).toBeNull();
  });

  it("feeds the dashboard's decoder unchanged", () => {
    const out = main({ data: [[block()]] })!;
    const history = buildHistory(out.logs, out.transfers, ME);
    const ski = history.kitties.get(SKI.toLowerCase())!;
    expect(ski.purchases[0]).toMatchObject({ id: ID, status: "paid" });
    expect(history.activity.some((e) => e.kind === "share")).toBe(true);
  });
});

describe("webhook payload", () => {
  it("finds rows bare, batched, or wrapped in data, and drops malformed ones", () => {
    const out = main({ data: [block()] })!;
    expect(rowsFrom(out).logs).toHaveLength(3);
    expect(rowsFrom([out, out]).logs).toHaveLength(6);
    expect(rowsFrom({ data: [out], metadata: {} }).transfers).toHaveLength(1);
    expect(rowsFrom({ logs: [{ topics: [], data: "0x", transactionHash: "nope" }], transfers: [{ hash: TX }] })).toEqual({ logs: [], transfers: [] });
  });

  it("checks QuickNode's HMAC over nonce + timestamp + body", () => {
    const secret = "s".repeat(32);
    const body = '{"logs":[]}';
    const sig = createHmac("sha256", secret).update(`n1` + `1700000000` + body).digest("hex");
    expect(validSignature(secret, "n1", "1700000000", body, sig)).toBe(true);
    expect(validSignature(secret, "n1", "1700000000", body + " ", sig)).toBe(false);
    expect(validSignature(secret, "n2", "1700000000", body, sig)).toBe(false);
    expect(validSignature("", "n1", "1700000000", body, sig)).toBe(false);
  });

  it("stored rows read back in the explorer's shape", () => {
    expect(logOut({ tx_hash: TX, log_index: 3, block: "73112860", ts: "1763745792", topics: [ID], data: "0x" })).toEqual({
      topics: [ID],
      data: "0x",
      transactionHash: TX,
      timeStamp: "0x6920a000",
      blockNumber: "0x45b9d1c",
      logIndex: "0x3",
    });
    expect(transferOut({ tx_hash: TX, log_index: 0, block: "5", ts: "7", from_addr: ME, to_addr: PAYER, value: "15000000" })).toMatchObject({
      hash: TX,
      value: "15000000",
      timeStamp: "7",
    });
  });
});
