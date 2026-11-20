/**
 * Shared by the Streams webhook (api/stream.ts) and the readers (api/history.ts, api/events.ts):
 * QuickNode signature checks, the payload's rows, and the Postgres tables they land in.
 * The leading underscore keeps Vercel from serving this file as its own function.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/** A treasury log as the Arc explorer returns it (numbers in hex). The Stream filter emits the same. */
export interface StreamLog {
  address?: string;
  topics: (string | null)[];
  data: string;
  transactionHash: string;
  timeStamp: string;
  blockNumber: string;
  logIndex: string;
}

/** A USDC transfer as the explorer's `tokentx` returns it (numbers in decimal). */
export interface StreamTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber?: string;
  logIndex?: string;
}

export interface StreamRows {
  logs: StreamLog[];
  transfers: StreamTransfer[];
}

/** QuickNode signs nonce + timestamp + body with the stream's security token (HMAC-SHA256, hex). */
export function validSignature(secret: string, nonce: string, timestamp: string, body: string, signature: string): boolean {
  if (!secret || !nonce || !timestamp || !signature) return false;
  const expected = createHmac("sha256", Buffer.from(secret)).update(Buffer.from(nonce + timestamp + body)).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

const HEX = /^0x[0-9a-fA-F]*$/;
const DEC = /^\d+$/;

function isLog(x: unknown): x is StreamLog {
  const l = x as StreamLog;
  return (
    !!l &&
    Array.isArray(l.topics) &&
    typeof l.data === "string" &&
    HEX.test(l.transactionHash ?? "") &&
    HEX.test(l.blockNumber ?? "") &&
    HEX.test(l.logIndex ?? "") &&
    HEX.test(l.timeStamp ?? "")
  );
}

function isTransfer(x: unknown): x is StreamTransfer {
  const t = x as StreamTransfer;
  return (
    !!t &&
    HEX.test(t.hash ?? "") &&
    HEX.test(t.from ?? "") &&
    HEX.test(t.to ?? "") &&
    DEC.test(t.value ?? "") &&
    DEC.test(t.timeStamp ?? "") &&
    DEC.test(t.blockNumber ?? "") &&
    DEC.test(t.logIndex ?? "")
  );
}

/**
 * The filter's output, wherever QuickNode put it: the bare `{logs, transfers}`, a list of them (one
 * per block in a batch), or wrapped in `{data: …}`. Malformed rows are dropped, not stored.
 */
export function rowsFrom(payload: unknown): StreamRows {
  const out: StreamRows = { logs: [], transfers: [] };
  const visit = (x: unknown, depth: number): void => {
    if (depth > 4 || x === null || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach((item) => visit(item, depth + 1));
    const o = x as Record<string, unknown>;
    if (Array.isArray(o.logs) || Array.isArray(o.transfers)) {
      out.logs.push(...((o.logs as unknown[]) ?? []).filter(isLog));
      out.transfers.push(...((o.transfers as unknown[]) ?? []).filter(isTransfer));
      return;
    }
    if ("data" in o) visit(o.data, depth + 1);
  };
  visit(payload, 0);
  return out;
}

export function db(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

let schemaReady: Promise<unknown> | undefined;

/** Creates the two tables on first use, so a fresh database needs no manual step (scripts/schema.sql is the same). */
export function ensureSchema(sql: NeonQueryFunction<false, false>): Promise<unknown> {
  schemaReady ??= sql
    .transaction([
      sql`create table if not exists kitty_logs (
        tx_hash text not null, log_index integer not null, block bigint not null, ts bigint not null,
        topics jsonb not null, data text not null, primary key (tx_hash, log_index))`,
      sql`create table if not exists kitty_transfers (
        tx_hash text not null, log_index integer not null, block bigint not null, ts bigint not null,
        from_addr text not null, to_addr text not null, value numeric not null, primary key (tx_hash, log_index))`,
      sql`create index if not exists kitty_transfers_from on kitty_transfers (from_addr)`,
      sql`create index if not exists kitty_transfers_to on kitty_transfers (to_addr)`,
    ])
    .catch((err: unknown) => {
      schemaReady = undefined;
      throw err;
    });
  return schemaReady;
}

/** Streams can deliver a block twice (retries, reorg fixes): the primary keys make that a no-op. */
export async function saveRows(sql: NeonQueryFunction<false, false>, rows: StreamRows): Promise<void> {
  const writes = [
    ...rows.logs.map(
      (l) => sql`insert into kitty_logs (tx_hash, log_index, block, ts, topics, data)
        values (${l.transactionHash.toLowerCase()}, ${Number(BigInt(l.logIndex))}, ${BigInt(l.blockNumber).toString()},
                ${BigInt(l.timeStamp).toString()}, ${JSON.stringify(l.topics)}, ${l.data})
        on conflict do nothing`,
    ),
    ...rows.transfers.map(
      (t) => sql`insert into kitty_transfers (tx_hash, log_index, block, ts, from_addr, to_addr, value)
        values (${t.hash.toLowerCase()}, ${Number(t.logIndex ?? 0)}, ${t.blockNumber ?? "0"}, ${t.timeStamp},
                ${t.from.toLowerCase()}, ${t.to.toLowerCase()}, ${t.value})
        on conflict do nothing`,
    ),
  ];
  if (writes.length) await sql.transaction(writes);
}

interface LogRow {
  tx_hash: string;
  log_index: number;
  block: string;
  ts: string;
  topics: (string | null)[];
  data: string;
}

interface TransferRow {
  tx_hash: string;
  log_index: number;
  block: string;
  ts: string;
  from_addr: string;
  to_addr: string;
  value: string;
}

const hex = (n: string | number) => `0x${BigInt(n).toString(16)}`;

/** Back to the explorer's shape, so the page's decoder doesn't care where a row came from. */
export function logOut(r: LogRow): StreamLog {
  return {
    topics: r.topics,
    data: r.data,
    transactionHash: r.tx_hash,
    timeStamp: hex(r.ts),
    blockNumber: hex(r.block),
    logIndex: hex(r.log_index),
  };
}

export function transferOut(r: TransferRow): StreamTransfer {
  return {
    hash: r.tx_hash,
    from: r.from_addr,
    to: r.to_addr,
    value: String(r.value),
    timeStamp: String(r.ts),
    blockNumber: String(r.block),
    logIndex: String(r.log_index),
  };
}

export async function treasuryLogs(sql: NeonQueryFunction<false, false>, after?: { block: bigint; logIndex: number }): Promise<StreamLog[]> {
  const rows = (after
    ? await sql`select * from kitty_logs where (block, log_index) > (${after.block.toString()}, ${after.logIndex})
        order by block, log_index limit 1000`
    : await sql`select * from kitty_logs order by block, log_index`) as LogRow[];
  return rows.map(logOut);
}

export async function accountTransfers(sql: NeonQueryFunction<false, false>, account: string): Promise<StreamTransfer[]> {
  const a = account.toLowerCase();
  const rows = (await sql`select * from kitty_transfers where from_addr = ${a} or to_addr = ${a}
    order by block desc, log_index desc`) as TransferRow[];
  return rows.map(transferOut);
}

export async function lastBlock(sql: NeonQueryFunction<false, false>): Promise<string | null> {
  const [row] = (await sql`select max(block)::text as block from kitty_logs`) as { block: string | null }[];
  return row?.block ?? null;
}
