/**
 * Helpers for building a `Split` from a total and a set of participants.
 * Shares always sum exactly back to the total.
 */

import type { Usdc } from "./money.js";
import { splitEven } from "./money.js";
import type { MemberId, ReceiptLineItem, Split } from "./types.js";

export interface EvenSplitInput {
  total: Usdc;
  participantIds: MemberId[];
  payeeMemberId: MemberId;
}

/** Split a total evenly across participants. */
export function evenSplit({ total, participantIds, payeeMemberId }: EvenSplitInput): Split {
  if (participantIds.length === 0) throw new Error("evenSplit: no participants");
  const parts = splitEven(total, participantIds.length);
  const shares: Record<MemberId, Usdc> = {};
  participantIds.forEach((id, i) => {
    shares[id] = parts[i]!;
  });
  return { total, method: { kind: "even" }, shares, payeeMemberId };
}

export interface CustomSplitInput {
  shares: Record<MemberId, Usdc>;
  payeeMemberId: MemberId;
}

/** Build a split from explicit per-member shares. The total is their sum. */
export function customSplit({ shares, payeeMemberId }: CustomSplitInput): Split {
  const total = Object.values(shares).reduce((a, b) => (a + b) as Usdc, 0n as Usdc);
  return { total, method: { kind: "custom", shares }, shares, payeeMemberId };
}

/** The share a given member owes, or 0n if they are not in the split. */
export function shareOf(split: Split, memberId: MemberId): Usdc {
  return (split.shares[memberId] ?? 0n) as Usdc;
}

export interface ByItemSplitInput {
  lineItems: ReceiptLineItem[];
  /** memberId -> indices of the line items they claimed. An item claimed by N members is split N ways. */
  claims: Record<MemberId, number[]>;
  tax?: Usdc;
  tip?: Usdc;
  payeeMemberId: MemberId;
}

/**
 * Split a receipt by what each person ordered: each member pays for their claimed items (a shared
 * item is divided among its claimers) plus a proportional share of tax and tip. All amounts are
 * integer micro-dollars and the shares sum exactly to the total (largest-remainder reconciles cents).
 */
export function byItemSplit({ lineItems, claims, tax, tip, payeeMemberId }: ByItemSplitInput): Split {
  const members = Object.keys(claims);
  if (members.length === 0) throw new Error("byItemSplit: no claims");

  // Each member's claimed-item subtotal (a shared item's amount is divided among its claimers).
  const base: Record<MemberId, bigint> = Object.fromEntries(members.map((m) => [m, 0n]));
  const claimers = new Map<number, MemberId[]>();
  for (const m of members) for (const idx of claims[m] ?? []) claimers.set(idx, [...(claimers.get(idx) ?? []), m]);
  for (const [idx, who] of claimers) {
    const amount = lineItems[idx]?.amount ?? (0n as Usdc);
    const parts = splitEven(amount, who.length);
    who.forEach((m, i) => (base[m]! += parts[i]!));
  }

  // Distribute tax + tip proportional to each member's item subtotal (largest remainder = exact sum).
  const itemsTotal = members.reduce((a, m) => a + base[m]!, 0n);
  const extra = (tax ?? 0n) + (tip ?? 0n);
  const shares: Record<MemberId, Usdc> = {};
  if (extra > 0n && itemsTotal > 0n) {
    const rows = members.map((m) => ({ m, whole: (base[m]! * extra) / itemsTotal, rem: (base[m]! * extra) % itemsTotal }));
    let leftover = extra - rows.reduce((a, r) => a + r.whole, 0n);
    rows.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0));
    for (const r of rows) {
      const bonus = leftover > 0n ? 1n : 0n;
      leftover -= bonus;
      shares[r.m] = (base[r.m]! + r.whole + bonus) as Usdc;
    }
  } else {
    for (const m of members) shares[m] = base[m]! as Usdc;
  }

  const total = Object.values(shares).reduce((a, b) => a + b, 0n) as Usdc;
  return { total, method: { kind: "by_item" }, shares, payeeMemberId };
}
