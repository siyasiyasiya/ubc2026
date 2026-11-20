/**
 * Past activity, read from the chain: every purchase in each kitty, and every dollar in or out of
 * the member's own Kitty account.
 *
 * The page has no backend and the public Arc RPC only serves small `eth_getLogs` ranges, so this
 * reads the Arc explorer's (Arcscan) Etherscan-style API (CORS-open, whole history in one call). Purchase names live
 * only in the chat, so a purchase here is its amount, its split, and whether it went through.
 */

import { decodeEventLog, type Hex } from "viem";
import { treasuryEvents } from "./abi";

// testnet.arcscan.app 301s here, and that redirect has no CORS header, so call this host directly.
const EXPLORER_API = "https://explorer.testnet.arc.io/api";
/** Arc's native USDC, as its ERC-20 interface (6 decimals). Top-ups and pulls both show up here. */
export const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const PAGE = 1000;
const MAX_PAGES = 10;

/** One treasury log as Arcscan returns it (numbers in hex). */
export interface ExplorerLog {
  topics: (Hex | null)[];
  data: Hex;
  transactionHash: Hex;
  timeStamp: string;
  blockNumber: string;
  logIndex: string;
}

/** One USDC transfer as Arcscan's `tokentx` returns it (numbers in decimal). */
export interface ExplorerTransfer {
  hash: Hex;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  logIndex?: string;
}

type Decoded = ReturnType<typeof decodeEventLog<typeof treasuryEvents>> & { tx: Hex; at: number; order: number };

export type PurchaseStatus = "waiting" | "paid" | "cancelled";

export interface Purchase {
  id: Hex;
  group: Hex;
  payee: string;
  total: bigint;
  at: number;
  status: PurchaseStatus;
  approvals: number;
  /** Shares that moved, and shares that turned into debts, once paid. */
  pulled: bigint;
  owed: bigint;
  /** This member's part: what came out of their account, or what they owe because it couldn't. */
  mine?: { amount: bigint; ok: boolean; reason?: string };
  /** This member was paid back by the group for it. */
  toMe: bigint;
  /** The transaction that moved the money (settle), or that proposed it until then. */
  tx?: Hex;
}

export interface Kitty {
  group: Hex;
  purchases: Purchase[];
  /** Wallets in the kitty right now. */
  members: number;
  /** All money the group has moved through Kitty. */
  spent: bigint;
  joinedAt?: number;
}

export type EntryKind = "added" | "sent" | "share" | "repaid" | "got" | "owe" | "joined" | "limit" | "left";

/** One line of "your activity". `amount` is signed USDC base units (6 decimals), absent for non-money events. */
export interface Entry {
  kind: EntryKind;
  at: number;
  tx: Hex;
  amount?: bigint;
  group?: Hex;
  limit?: bigint;
  period?: number;
  /** The purchase this money moved for (shares and missed shares), so the page can name it. */
  purchase?: Hex;
  /** The limit was changed by Kitty (the operator), not the member. */
  byKitty?: boolean;
  reason?: string;
}

export interface History {
  kitties: Map<string, Kitty>;
  /** Kitties this account ever joined, oldest first. */
  joined: Hex[];
  activity: Entry[];
  /** The transfer list didn't load: top-ups are missing, everything from the contract is there. */
  partial?: boolean;
}

const lower = (s: string) => s.toLowerCase();

/** Decodes the treasury's logs; anything it doesn't recognise is skipped. */
export function decodeLogs(logs: ExplorerLog[]): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    const topics = log.topics.filter((t): t is Hex => Boolean(t));
    if (topics.length === 0) continue;
    try {
      const event = decodeEventLog({ abi: treasuryEvents, data: log.data, topics: topics as [Hex, ...Hex[]] });
      const block = Number(log.blockNumber);
      out.push({ ...event, tx: log.transactionHash, at: Number(log.timeStamp), order: block * 10_000 + Number(log.logIndex || 0) });
    } catch {
      // Another contract's event at this address, or a newer event this page doesn't know.
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/** Every kitty's purchases, and this account's own activity, from the treasury's logs and its USDC transfers. */
export function buildHistory(logs: ExplorerLog[], transfers: ExplorerTransfer[], account: string): History {
  const me = lower(account);
  const events = decodeLogs(logs);
  const kitties = new Map<string, Kitty>();
  const kitty = (group: Hex): Kitty => {
    const key = lower(group);
    let k = kitties.get(key);
    if (!k) kitties.set(key, (k = { group, purchases: [], members: 0, spent: 0n }));
    return k;
  };
  const purchases = new Map<string, Purchase>();
  const inKitty = new Map<string, Set<string>>();
  const joined: Hex[] = [];
  const activity: Entry[] = [];
  /**
   * Money the treasury moved for this account, listed from its own events (so shares show even
   * without the transfer list). Keyed by tx so the matching USDC transfer isn't listed twice.
   */
  const explained = new Map<string, { other: string; amount: bigint; incoming: boolean }[]>();
  const moved = (e: Decoded, kind: EntryKind, other: string, amount: bigint, group?: Hex, purchase?: Hex) => {
    const incoming = kind === "got";
    activity.push({ kind, at: e.at, tx: e.tx, amount: incoming ? amount : -amount, group, ...(purchase ? { purchase } : {}) });
    const list = explained.get(lower(e.tx)) ?? [];
    list.push({ other: lower(other), amount, incoming });
    explained.set(lower(e.tx), list);
  };

  for (const e of events) {
    switch (e.eventName) {
      case "Joined": {
        const set = inKitty.get(lower(e.args.group)) ?? new Set();
        set.add(lower(e.args.member));
        inKitty.set(lower(e.args.group), set);
        const k = kitty(e.args.group);
        if (lower(e.args.member) === me) {
          if (!joined.some((g) => lower(g) === lower(e.args.group))) joined.push(e.args.group);
          k.joinedAt ??= e.at;
          activity.push({ kind: "joined", at: e.at, tx: e.tx, group: e.args.group, limit: e.args.limit, period: e.args.period });
        }
        break;
      }
      case "Left":
        inKitty.get(lower(e.args.group))?.delete(lower(e.args.member));
        if (lower(e.args.member) === me) {
          activity.push({ kind: "left", at: e.at, tx: e.tx, group: e.args.group, byKitty: lower(e.args.by) !== me });
        }
        break;
      case "LimitSet":
        if (lower(e.args.member) === me) {
          activity.push({ kind: "limit", at: e.at, tx: e.tx, group: e.args.group, limit: e.args.limit, period: e.args.period, byKitty: lower(e.args.by) !== me });
        }
        break;
      case "SpendProposed": {
        const p: Purchase = { id: e.args.id, group: e.args.group, payee: e.args.payee, total: e.args.total, at: e.at, status: "waiting", approvals: 0, pulled: 0n, owed: 0n, toMe: 0n, tx: e.tx };
        purchases.set(lower(e.args.id), p);
        kitty(e.args.group).purchases.push(p);
        break;
      }
      case "SpendApproved": {
        const p = purchases.get(lower(e.args.id));
        if (p) p.approvals += 1;
        break;
      }
      case "SpendCancelled": {
        const p = purchases.get(lower(e.args.id));
        if (p) p.status = "cancelled";
        break;
      }
      case "SharePulled": {
        const p = purchases.get(lower(e.args.id));
        if (lower(e.args.from) === me) {
          if (p) p.mine = { amount: e.args.amount, ok: true };
          moved(e, "share", e.args.to, e.args.amount, p?.group, e.args.id);
        }
        if (lower(e.args.to) === me) {
          if (p) p.toMe += e.args.amount;
          moved(e, "got", e.args.from, e.args.amount, p?.group, e.args.id);
        }
        break;
      }
      case "PullFailed": {
        const p = purchases.get(lower(e.args.id));
        if (lower(e.args.from) === me) {
          if (p) p.mine = { amount: e.args.amount, ok: false, reason: e.args.reason };
          activity.push({ kind: "owe", at: e.at, tx: e.tx, group: p?.group, amount: e.args.amount, reason: e.args.reason, purchase: e.args.id });
        }
        break;
      }
      case "SpendSettled": {
        const p = purchases.get(lower(e.args.id));
        if (p) {
          p.status = "paid";
          p.tx = e.tx;
          p.pulled = e.args.pulled;
          p.owed = e.args.owed;
          kitty(p.group).spent += e.args.pulled;
        }
        break;
      }
      case "DebtPaid":
        if (lower(e.args.debtor) === me) moved(e, "repaid", e.args.creditor, e.args.amount);
        if (lower(e.args.creditor) === me) moved(e, "got", e.args.debtor, e.args.amount);
        break;
    }
  }

  for (const [key, members] of inKitty) kitty(key as Hex).members = members.size;
  for (const k of kitties.values()) k.purchases.reverse();

  // Other money in and out of the account: coming in is a top-up (Apple Pay, test money, a friend),
  // going out was sent. Transfers the treasury's events already listed are skipped.
  const seen = new Set<string>();
  for (const t of transfers) {
    const amount = BigInt(t.value || "0");
    if (amount === 0n) continue;
    const key = `${lower(t.hash)}:${t.logIndex ?? ""}:${lower(t.from)}:${lower(t.to)}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const incoming = lower(t.to) === me;
    if (!incoming && lower(t.from) !== me) continue;
    const other = incoming ? lower(t.from) : lower(t.to);
    const list = explained.get(lower(t.hash)) ?? [];
    const i = list.findIndex((l) => l.other === other && l.amount === amount && l.incoming === incoming);
    if (i >= 0) {
      list.splice(i, 1);
      continue;
    }
    activity.push({ kind: incoming ? "added" : "sent", at: Number(t.timeStamp), tx: t.hash, amount: incoming ? amount : -amount });
  }

  activity.sort((a, b) => b.at - a.at);
  return { kitties, joined, activity };
}

interface ExplorerReply<T> {
  status?: string;
  message?: string;
  result?: T[] | string | null;
}

export interface LoadOptions {
  fetcher?: typeof fetch;
  /** Waits between retries; tests pass one that doesn't. */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RETRY_MS = [1_500, 4_000];

/**
 * Where to ask: the page's own cached proxy (api/explorer.ts) first, so phones sharing a Wi-Fi IP
 * share one copy; the explorer itself when the proxy isn't there (local dev) or fails.
 */
const SOURCES = ["/api/explorer", EXPLORER_API];

async function explorerPage<T>(query: URLSearchParams, options: LoadOptions): Promise<ExplorerReply<T>> {
  let last: unknown;
  for (const base of SOURCES) {
    try {
      return await fromSource<T>(`${base}?${query}`, options);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** One explorer call, retried when the explorer says it's busy (it rate-limits per IP without a key). */
async function fromSource<T>(url: string, { fetcher = fetch, wait = sleep }: LoadOptions): Promise<ExplorerReply<T>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(url);
    // Vite's dev server answers /api/* with the HTML page: not JSON means there's no proxy here.
    const body = (await res.json().catch(() => undefined)) as ExplorerReply<T> | undefined;
    if (!body) throw new Error(`Arcscan: not JSON (HTTP ${res.status}) from ${url.split("?")[0]}`);
    const busy = res.status === 429 || /too many requests|rate limit/i.test(body.message ?? "");
    if (busy && attempt < RETRY_MS.length) {
      await wait(RETRY_MS[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Arcscan HTTP ${res.status}${body.message ? `: ${body.message}` : ""}`);
    return body;
  }
}

/** Pages through an Arcscan list endpoint. "No records found" is an empty list, not an error. */
async function explorerList<T>(query: Record<string, string>, options: LoadOptions): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await explorerPage<T>(new URLSearchParams({ ...query, page: String(page), offset: String(PAGE) }), options);
    if (!Array.isArray(body.result)) {
      if (/no (records|logs|transactions|token transfers) found/i.test(body.message ?? "")) break;
      throw new Error(`Arcscan: ${body.message ?? "unexpected reply"}`);
    }
    out.push(...body.result);
    if (body.result.length < PAGE) break;
  }
  return out;
}

const cacheKey = (treasury: string, account: string) => `kitty.history.v1:${lower(treasury)}:${lower(account)}`;

/** The last history loaded on this phone, so the page has something to show at once (and when the explorer is down). */
export function cachedHistory(treasury: Hex, account: Hex): History | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey(treasury, account)) ?? "null") as { logs: ExplorerLog[]; transfers: ExplorerTransfer[] } | null;
    return raw ? buildHistory(raw.logs, raw.transfers, account) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * api/history.ts: rows the QuickNode Stream delivered (scripts/create-stream.mjs). Undefined when
 * there's no store yet (local dev, empty table, other contract), so the caller asks the explorer.
 */
async function fromStream(treasury: Hex, account: Hex, { fetcher = fetch }: LoadOptions): Promise<{ logs: ExplorerLog[]; transfers: ExplorerTransfer[] } | undefined> {
  try {
    const res = await fetcher(`/api/history?${new URLSearchParams({ account, treasury })}`);
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => undefined)) as { logs?: unknown; transfers?: unknown } | undefined;
    if (!body || !Array.isArray(body.logs) || !body.logs.length || !Array.isArray(body.transfers)) return undefined;
    return { logs: body.logs as ExplorerLog[], transfers: body.transfers as ExplorerTransfer[] };
  } catch {
    return undefined;
  }
}

/** One list of the account's transfers when both sources saw the same one. */
function mergeTransfers(a: ExplorerTransfer[], b: ExplorerTransfer[]): ExplorerTransfer[] {
  const key = (t: ExplorerTransfer) => `${lower(t.hash)}:${lower(t.from)}>${lower(t.to)}:${t.value}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((t) => !seen.has(key(t)))];
}

/** Fetches everything the history views need for one account. */
export async function loadHistory(treasury: Hex, account: Hex, options: LoadOptions = {}): Promise<History> {
  // The log list is the one that matters (purchases, shares, caps); top-ups alone may fail.
  // Logs come from our QuickNode Stream store when it's there (no explorer rate limit), else the explorer.
  const [stream, explorerTransfers] = await Promise.all([
    fromStream(treasury, account, options),
    explorerList<ExplorerTransfer>({ module: "account", action: "tokentx", address: account, contractaddress: USDC_ERC20, sort: "desc" }, options).catch((err: unknown) => {
      console.error("transfers", err);
      return undefined;
    }),
  ]);
  const logs = stream?.logs ?? (await explorerList<ExplorerLog>({ module: "logs", action: "getLogs", address: treasury, fromBlock: "0", toBlock: "latest" }, options));
  const transfers = explorerTransfers ? mergeTransfers(explorerTransfers, stream?.transfers ?? []) : undefined;
  if (!transfers) return { ...buildHistory(logs, stream?.transfers ?? [], account), partial: true };
  try {
    localStorage.setItem(cacheKey(treasury, account), JSON.stringify({ logs, transfers }));
  } catch {
    // No storage (private browsing, tests, or full): the next visit just loads fresh.
  }
  return buildHistory(logs, transfers, account);
}
