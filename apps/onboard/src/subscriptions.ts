/**
 * Subscriptions (Spotify, rent) for the dashboard. They live on Kitty's server, and the page has
 * no backend, so Kitty's links carry them: `s=group~every~status~total~myShare~nextAt~payee~payeeName~title`
 * (apps/server/src/runtime.ts `subscriptionParam`). The phone remembers the last list, and a link
 * marked `sv=1` replaces it, so a cancelled one disappears.
 */

import { isAddress, isHex, type Hex } from "viem";

export interface SubscriptionRef {
  group: Hex;
  title: string;
  every: "weekly" | "monthly";
  /** Still waiting on the group's 👍s to start. */
  pending: boolean;
  /** Full amount each time, and this member's part (0 when they're the one paid back). USDC base units. */
  total: bigint;
  mine: bigint;
  /** Seconds; 0 until it starts. */
  nextAt: number;
  /** Who gets paid back, so their charges can be named in the chain history. */
  payee?: string;
  payeeName: string;
}

const KEY = "kitty.subs.v1";

export function parseSubscription(param: string): SubscriptionRef | undefined {
  const parts = param.split("~");
  if (parts.length < 9) return undefined;
  const [group, every, status, total, mine, next, payee, payeeName] = parts as [string, string, string, string, string, string, string, string];
  const title = parts.slice(8).join("~").trim();
  if (!isHex(group) || group.length !== 66 || (every !== "weekly" && every !== "monthly") || !title) return undefined;
  if (!/^\d+$/.test(total) || !/^\d+$/.test(mine) || !/^\d+$/.test(next)) return undefined;
  return {
    group,
    title,
    every,
    pending: status === "p",
    total: BigInt(total),
    mine: BigInt(mine),
    nextAt: Number(next),
    ...(isAddress(payee) ? { payee } : {}),
    payeeName: payeeName === "-" ? "" : payeeName,
  };
}

type Stored = Omit<SubscriptionRef, "total" | "mine"> & { total: string; mine: string };

/** The link's subscriptions, or (on a link that doesn't list them) the ones this phone saw last. */
export function subscriptionsFromLink(params: URLSearchParams): SubscriptionRef[] {
  const fromLink = params.getAll("s").map(parseSubscription).filter((s): s is SubscriptionRef => Boolean(s));
  if (params.get("sv") === "1") {
    try {
      const stored: Stored[] = fromLink.map((s) => ({ ...s, total: s.total.toString(), mine: s.mine.toString() }));
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      // Private browsing: this visit still has them.
    }
    return fromLink;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Stored[];
    return saved.map((s) => ({ ...s, total: BigInt(s.total), mine: BigInt(s.mine) }));
  } catch {
    return fromLink;
  }
}

/** About what this costs a month: weekly charges times 52 / 12. For a total line, so rounding to cents is fine. */
export function perMonth(sub: SubscriptionRef): bigint {
  return sub.every === "monthly" ? sub.mine : (sub.mine * 52n) / 12n;
}
