/**
 * Helpers for building a `Split` from a total and a set of participants.
 * Shares always sum exactly back to the total.
 */

import type { Usdc } from "./money.js";
import { splitEven } from "./money.js";
import type { MemberId, Split } from "./types.js";

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
