/**
 * @gta/wallet — WalletAdapter implementations.
 *
 * `InMemoryWalletAdapter` is for local dev, the simulator, and the demo until the Arc contract
 * is wired in. It is NOT production: balances live in memory. It enforces the same rule the
 * contract will: never pull more than what's left of a member's recurring limit this period.
 */

import {
  formatUsdc,
  micros,
  type LimitStatus,
  type Member,
  type MemberId,
  type PullOutcome,
  type PullParams,
  type Usdc,
  type WalletAdapter,
} from "@gta/core";

/** Start of the current period (UTC): Monday for weekly limits, the 1st for monthly. */
export function periodStart(period: "weekly" | "monthly", now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "monthly") d.setUTCDate(1);
  else d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

export function periodEnd(period: "weekly" | "monthly", now: Date = new Date()): Date {
  const start = periodStart(period, now);
  if (period === "monthly") start.setUTCMonth(start.getUTCMonth() + 1);
  else start.setUTCDate(start.getUTCDate() + 7);
  return start;
}

interface SpendRecord {
  periodStart: number;
  spent: bigint;
}

/** In-memory wallet with recurring limits. Not production. */
export class InMemoryWalletAdapter implements WalletAdapter {
  readonly id = "in-memory";
  private readonly spending = new Map<MemberId, SpendRecord>();
  private readonly completed = new Map<string, PullOutcome>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private spentThisPeriod(member: Member): bigint {
    const record = this.spending.get(member.id);
    const start = periodStart(member.limit.period, this.now()).getTime();
    return record && record.periodStart === start ? record.spent : 0n;
  }

  async getLimitStatus(member: Member): Promise<LimitStatus> {
    const remaining = member.limit.amount - this.spentThisPeriod(member);
    return {
      limit: member.limit,
      remaining: micros(remaining > 0n ? remaining : 0n),
      resetsAt: periodEnd(member.limit.period, this.now()).getTime(),
    };
  }

  async canPull(member: Member, amount: Usdc): Promise<{ ok: boolean; remaining: Usdc }> {
    const { remaining } = await this.getLimitStatus(member);
    return { ok: amount <= remaining, remaining };
  }

  async pull(params: PullParams): Promise<PullOutcome> {
    const previous = this.completed.get(params.idempotencyKey);
    if (previous) return previous; // a retried pull never double-charges

    const { ok, remaining } = await this.canPull(params.from, params.amount);
    const outcome: PullOutcome = ok
      ? { status: "pulled", txRef: `mem-${params.idempotencyKey}` }
      : {
          status: "failed",
          reason: `over limit (${formatUsdc(remaining)} left this ${params.from.limit.period === "weekly" ? "week" : "month"})`,
        };
    if (ok) {
      this.spending.set(params.from.id, {
        periodStart: periodStart(params.from.limit.period, this.now()).getTime(),
        spent: this.spentThisPeriod(params.from) + params.amount,
      });
    }
    this.completed.set(params.idempotencyKey, outcome);
    return outcome;
  }
}

export { ArcWalletAdapter, arcClients, arcWalletAdapters, groupIdForChat, pullSpendId } from "./arc.js";
export type { ArcClients, ArcEnv, ArcWalletAdapterOptions } from "./arc.js";
export { groupTreasuryAbi } from "./treasury-abi.js";
export { inviteLink, inviteTicket, JoinWatcher, sendWelcomeBalance } from "./join.js";
export type { InviteLinkInput, JoinEvent, JoinWatcherOptions } from "./join.js";
