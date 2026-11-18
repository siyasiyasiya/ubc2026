import { formatUsd, sumShares } from "./money.js";
import { memberName } from "./store.js";
import type { GroupState, Handle, Proposal, Settlement, Transfer, Units } from "./types.js";

/**
 * Moves each participant's share to the payer. The mock version below keeps balances in memory;
 * the onchain version calls the GroupTreasury contract on Arc, which re-checks the same rules.
 */
export interface Treasury {
  settle(group: GroupState, proposal: Proposal): Promise<Settlement>;
}

/** Participants who must 👍 before money moves: everyone in the split except the payer. */
export function requiredApprovers(proposal: Proposal): Handle[] {
  return Object.keys(proposal.shares).filter((h) => h !== proposal.payer);
}

export function isFullyApproved(proposal: Proposal): boolean {
  return requiredApprovers(proposal).every((h) => proposal.approvals.includes(h));
}

/** Monday of the current week (UTC), as YYYY-MM-DD. Weekly limits reset then. */
export function weekStart(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

export function spentThisWeek(group: GroupState, handle: Handle, now?: Date): Units {
  const entry = group.spending[handle];
  return entry && entry.weekStart === weekStart(now) ? entry.amount : 0;
}

/**
 * The safety rules every settlement must pass, whatever the agent says. Returns the problems found;
 * an empty list means the proposal may settle.
 */
export function settlementProblems(group: GroupState, proposal: Proposal, now?: Date): string[] {
  const problems: string[] = [];
  if (proposal.status !== "pending")
    problems.push(`#${proposal.number} is already ${proposal.status}`);
  if (sumShares(proposal.shares) !== proposal.total)
    problems.push("shares don't add up to the total");
  if (!isFullyApproved(proposal)) problems.push("not everyone in the split has approved");

  for (const [handle, share] of Object.entries(proposal.shares)) {
    if (handle === proposal.payer) continue;
    const member = group.members.find((m) => m.handle === handle);
    if (!member) {
      problems.push(`${handle} isn't a member of this group`);
      continue;
    }
    const remaining = member.weeklyLimit - spentThisWeek(group, handle, now);
    if (share > remaining) {
      problems.push(
        `${member.name}'s share ${formatUsd(share)} is over their remaining weekly limit (${formatUsd(Math.max(remaining, 0))})`,
      );
    }
  }
  return problems;
}

export function transfersFor(proposal: Proposal): Transfer[] {
  return Object.entries(proposal.shares)
    .filter(([handle, amount]) => handle !== proposal.payer && amount > 0)
    .map(([from, amount]) => ({ from, to: proposal.payer, amount }));
}

/** In-memory treasury for local testing and the simulator. Enforces the same rules as the contract. */
export class MockTreasury implements Treasury {
  async settle(group: GroupState, proposal: Proposal): Promise<Settlement> {
    const problems = settlementProblems(group, proposal);
    if (problems.length > 0) return { ok: false, transfers: [], error: problems.join("; ") };

    const transfers = transfersFor(proposal);
    const week = weekStart();
    for (const t of transfers) {
      group.spending[t.from] = { weekStart: week, amount: spentThisWeek(group, t.from) + t.amount };
    }
    return { ok: true, transfers, reference: `mock-${proposal.number}-${Date.now()}` };
  }
}

export function describeTransfers(group: GroupState, transfers: Transfer[]): string {
  return transfers
    .map((t) => `${memberName(group, t.from)} → ${memberName(group, t.to)} ${formatUsd(t.amount)}`)
    .join("\n");
}
