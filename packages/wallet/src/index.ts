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
  type LimitPeriod,
  type PledgeOutcome,
  type PoolParams,
  type PullOutcome,
  type PullParams,
  type Usdc,
  type WalletAdapter,
} from "@gta/core";

/** Start of the current period (UTC): Monday for weekly limits, the 1st for monthly, epoch for once. */
export function periodStart(period: LimitPeriod, now: Date = new Date()): Date {
  if (period === "once") return new Date(0);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "monthly") d.setUTCDate(1);
  else d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

/** When the period refills; a one-time limit never does (year 9999). */
export function periodEnd(period: LimitPeriod, now: Date = new Date()): Date {
  if (period === "once") return new Date(Date.UTC(9999, 0, 1));
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
          reason: `over limit (${formatUsdc(remaining)} left${params.from.limit.period === "once" ? "" : ` this ${params.from.limit.period === "weekly" ? "week" : "month"}`})`,
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

  private readonly pools = new Map<string, PoolParams & { backers: Member[]; status: "open" | "filled" | "refunded" }>();

  async openPool(params: PoolParams): Promise<void> {
    if (this.pools.has(params.poolId)) throw new Error("pool exists");
    this.pools.set(params.poolId, { ...params, backers: [], status: "open" });
  }

  async pledge(poolId: string, member: Member): Promise<PledgeOutcome> {
    const pool = this.pools.get(poolId);
    if (!pool || pool.status !== "open") return { status: "failed", reason: "this buy is closed" };
    if (this.now().getTime() > pool.deadline) return { status: "failed", reason: "too late, the deadline passed" };
    if (pool.backers.some((b) => b.id === member.id)) return { status: "failed", reason: "already in" };
    const { ok, remaining } = await this.canPull(member, pool.each);
    if (!ok) return { status: "failed", reason: `over limit (${formatUsdc(remaining)} left)` };
    this.addSpent(member, pool.each);
    pool.backers.push(member);
    const filled = pool.backers.length === pool.needed;
    if (filled) pool.status = "filled";
    return { status: "pledged", count: pool.backers.length, filled, txRef: `mem-pool-${poolId}-${pool.backers.length}` };
  }

  async refundPool(poolId: string): Promise<void> {
    const pool = this.pools.get(poolId);
    if (!pool || pool.status !== "open") return;
    pool.status = "refunded";
    for (const b of pool.backers) this.addSpent(b, -pool.each);
  }

  private addSpent(member: Member, amount: bigint): void {
    const spent = this.spentThisPeriod(member) + amount;
    this.spending.set(member.id, {
      periodStart: periodStart(member.limit.period, this.now()).getTime(),
      spent: spent > 0n ? spent : 0n,
    });
  }
}

export { ArcWalletAdapter, arcClients, arcWalletAdapters, groupIdForChat, poolIdFor, pullSpendId } from "./arc.js";
export type { ArcClients, ArcEnv, ArcWalletAdapterOptions } from "./arc.js";
export { groupTreasuryAbi } from "./treasury-abi.js";
export { inviteLink, inviteTicket, JoinWatcher, sendWelcomeBalance } from "./join.js";
export type { DebtPaidEvent, InviteLinkInput, JoinEvent, JoinWatcherOptions, LimitSetEvent } from "./join.js";
