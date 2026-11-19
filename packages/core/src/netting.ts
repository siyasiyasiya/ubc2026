/**
 * Settle-up netting: collapse a set of pairwise debts into the fewest transfers that make everyone
 * whole. Each member's net balance is what they're owed minus what they owe; we then greedily match
 * the biggest creditor with the biggest debtor until all balances are zero. Deterministic, integer
 * micro-dollars only (never floats).
 */

import type { Usdc } from "./money.js";
import type { MemberId } from "./types.js";

export interface Transfer {
  from: MemberId;
  to: MemberId;
  amount: Usdc;
}

/** Collapse pairwise debts (`from` owes `to`) into the minimal set of transfers that settles them. */
export function netTransfers(debts: Transfer[]): Transfer[] {
  const balance = new Map<MemberId, bigint>(); // >0 = net owed money, <0 = net owes money
  for (const d of debts) {
    if (d.amount <= 0n) continue;
    balance.set(d.from, (balance.get(d.from) ?? 0n) - d.amount);
    balance.set(d.to, (balance.get(d.to) ?? 0n) + d.amount);
  }
  // Sort by member id so ties resolve deterministically; then greedily pick the current max each pass.
  const owed = [...balance].filter(([, v]) => v > 0n).map(([m, v]) => ({ m, v })).sort((a, b) => (a.m < b.m ? -1 : 1));
  const owes = [...balance].filter(([, v]) => v < 0n).map(([m, v]) => ({ m, v: -v })).sort((a, b) => (a.m < b.m ? -1 : 1));

  const maxIndex = (xs: { v: bigint }[]) => {
    let at = -1;
    for (let i = 0; i < xs.length; i++) if (xs[i]!.v > 0n && (at < 0 || xs[i]!.v > xs[at]!.v)) at = i;
    return at;
  };

  const out: Transfer[] = [];
  for (;;) {
    const c = maxIndex(owed);
    const d = maxIndex(owes);
    if (c < 0 || d < 0) break;
    const pay = owed[c]!.v < owes[d]!.v ? owed[c]!.v : owes[d]!.v;
    out.push({ from: owes[d]!.m, to: owed[c]!.m, amount: pay as Usdc });
    owed[c]!.v -= pay;
    owes[d]!.v -= pay;
  }
  return out;
}
