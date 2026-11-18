/**
 * The request state machine.
 *
 * A pure reducer: `transition(state, event)` returns the next state plus a list
 * of `Effect`s the runtime should perform. The runtime (server/agent) carries
 * out effects using the ports, and feeds the results back in as events. The
 * reducer itself does no I/O, so it is fully unit-testable.
 *
 * Pay-before path:
 *   draft → cart_built → awaiting_approval → approved → placing_order
 *         → settling → done
 *
 * Pay-after path:
 *   collecting → awaiting_receipt → (awaiting_approval if over estimate)
 *             → settling → done
 *
 * Terminal failure states: rejected, cancelled, failed.
 */

import type { Usdc } from "./money.js";
import { formatUsdc, gtUsdc, subUsdc } from "./money.js";
import type {
  Approval,
  Cart,
  Debt,
  MemberId,
  PullResult,
  Receipt,
  Screenshot,
  Split,
} from "./types.js";

/** The reaction emoji that counts as an approval. */
export const APPROVAL_EMOJI = "👍";

// ----------------------------------------------------------------------------
// States
// ----------------------------------------------------------------------------

export type RequestState =
  // shared start for the pay-before flow
  | { name: "draft" }
  | { name: "cart_built"; cart: Cart }
  | {
      name: "awaiting_approval";
      cart?: Cart;
      split: Split;
      screenshot: Screenshot;
      approvals: Approval[];
      requiredApprovers: MemberId[];
      deadline: number;
      /** A pay-after re-approval carries the final receipt. */
      receipt?: Receipt;
    }
  | { name: "approved"; cart?: Cart; split: Split; receipt?: Receipt }
  | { name: "placing_order"; cart: Cart; split: Split }
  | { name: "settling"; receipt: Receipt; split: Split; pulls: PullResult[] }
  | { name: "done"; receipt: Receipt; split: Split; pulls: PullResult[]; debts: Debt[] }
  // pay-after start
  | { name: "collecting"; participants: MemberId[]; estimate?: Usdc; deadline?: number }
  | { name: "awaiting_receipt"; participants: MemberId[]; estimate?: Usdc }
  // terminal failures
  | { name: "rejected"; reason: string }
  | { name: "cancelled"; reason?: string }
  | { name: "failed"; reason: string; debts: Debt[] };

export type StateName = RequestState["name"];

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

export type RequestEvent =
  // pay-before
  | { type: "cart_built"; cart: Cart }
  | {
      type: "preview_ready";
      split: Split;
      screenshot: Screenshot;
      requiredApprovers: MemberId[];
      deadline: number;
      cart?: Cart;
    }
  | { type: "reaction"; memberId: MemberId; emoji: string; added: boolean; at: number }
  | { type: "approval_timeout"; at: number }
  | { type: "order_placed"; receipt: Receipt }
  // settlement (shared)
  | { type: "share_pulled"; result: PullResult }
  | { type: "settle_complete"; at: number }
  // pay-after
  | { type: "participant_in"; memberId: MemberId }
  | { type: "participant_out"; memberId: MemberId }
  | { type: "participants_locked"; estimate?: Usdc }
  | {
      type: "receipt_read";
      receipt: Receipt;
      split: Split;
      screenshot: Screenshot;
      /** How far over the estimate is tolerated before re-approval. */
      tolerance: Usdc;
      deadline: number;
    }
  // shared controls
  | { type: "cancel"; reason?: string }
  | { type: "fail"; reason: string };

// ----------------------------------------------------------------------------
// Effects — what the runtime should do next.
// ----------------------------------------------------------------------------

export type Effect =
  | { type: "build_cart" }
  | { type: "preview_cart"; cart: Cart }
  | { type: "post_preview"; screenshot: Screenshot; split: Split }
  | { type: "place_order"; cart: Cart }
  | { type: "pull_shares"; split: Split }
  | { type: "notify"; text: string };

export interface TransitionResult {
  state: RequestState;
  effects: Effect[];
  /** Set when the event was not valid for the current state; state is unchanged. */
  error?: string;
}

// ----------------------------------------------------------------------------
// Constructors
// ----------------------------------------------------------------------------

export function initialState(flow: "pay_before" | "pay_after"): RequestState {
  return flow === "pay_before"
    ? { name: "draft" }
    : { name: "collecting", participants: [] };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ok(state: RequestState, effects: Effect[] = []): TransitionResult {
  return { state, effects };
}

function invalid(state: RequestState, event: RequestEvent): TransitionResult {
  return { state, effects: [], error: `invalid event '${event.type}' in state '${state.name}'` };
}

/** True once every required approver has an active 👍. */
export function everyoneApproved(
  approvals: Approval[],
  requiredApprovers: MemberId[],
): boolean {
  if (requiredApprovers.length === 0) return false;
  const approved = new Set(
    approvals.filter((a) => a.emoji === APPROVAL_EMOJI).map((a) => a.memberId),
  );
  return requiredApprovers.every((m) => approved.has(m));
}

function applyReaction(
  approvals: Approval[],
  memberId: MemberId,
  emoji: string,
  added: boolean,
  at: number,
): Approval[] {
  // Drop any prior reaction of this emoji by this member, then re-add if active.
  const without = approvals.filter((a) => !(a.memberId === memberId && a.emoji === emoji));
  return added ? [...without, { memberId, emoji, at }] : without;
}

function buildDebts(pulls: PullResult[], at: number): Debt[] {
  return pulls
    .filter((p) => p.status === "failed")
    .map((p) => ({
      memberId: p.memberId,
      amount: p.amount,
      reason: p.reason ?? "pull failed",
      createdAt: at,
    }));
}

/** Whether every share in the split has a terminal pull outcome. */
function allSharesAttempted(split: Split, pulls: PullResult[]): boolean {
  const done = new Set(pulls.map((p) => p.memberId));
  return Object.keys(split.shares).every((m) => done.has(m));
}

// ----------------------------------------------------------------------------
// The reducer
// ----------------------------------------------------------------------------

export function transition(state: RequestState, event: RequestEvent): TransitionResult {
  // Global controls allowed from any non-terminal state.
  if (event.type === "cancel" && !isTerminal(state)) {
    return ok({ name: "cancelled", reason: event.reason });
  }
  if (event.type === "fail" && !isTerminal(state)) {
    return ok({ name: "failed", reason: event.reason, debts: [] });
  }

  switch (state.name) {
    // --- pay-before -------------------------------------------------------
    case "draft": {
      if (event.type === "cart_built") {
        return ok({ name: "cart_built", cart: event.cart }, [
          { type: "preview_cart", cart: event.cart },
        ]);
      }
      return invalid(state, event);
    }

    case "cart_built": {
      if (event.type === "preview_ready") {
        const next: RequestState = {
          name: "awaiting_approval",
          cart: event.cart ?? state.cart,
          split: event.split,
          screenshot: event.screenshot,
          approvals: [],
          requiredApprovers: event.requiredApprovers,
          deadline: event.deadline,
        };
        return ok(next, [{ type: "post_preview", screenshot: event.screenshot, split: event.split }]);
      }
      return invalid(state, event);
    }

    // --- approval (shared by both flows) ----------------------------------
    case "awaiting_approval": {
      if (event.type === "reaction") {
        const approvals = applyReaction(
          state.approvals,
          event.memberId,
          event.emoji,
          event.added,
          event.at,
        );
        if (everyoneApproved(approvals, state.requiredApprovers)) {
          // Pay-after re-approval already has the receipt → go straight to settling.
          if (state.receipt) {
            return ok(
              { name: "settling", receipt: state.receipt, split: state.split, pulls: [] },
              [{ type: "pull_shares", split: state.split }],
            );
          }
          return ok({ name: "approved", cart: state.cart, split: state.split }, [
            ...(state.cart ? [{ type: "place_order", cart: state.cart } as Effect] : []),
          ]);
        }
        return ok({ ...state, approvals });
      }
      if (event.type === "approval_timeout") {
        const missing = state.requiredApprovers.filter(
          (m) => !everyoneApproved([...state.approvals], [m]),
        );
        return ok({
          name: "rejected",
          reason: `approval timed out; missing 👍 from ${missing.length} member(s)`,
        });
      }
      return invalid(state, event);
    }

    case "approved": {
      if (event.type === "order_placed") {
        return ok({ name: "settling", receipt: event.receipt, split: state.split, pulls: [] }, [
          { type: "pull_shares", split: state.split },
        ]);
      }
      return invalid(state, event);
    }

    // --- settlement (shared) ----------------------------------------------
    case "settling": {
      if (event.type === "share_pulled") {
        const pulls = [...state.pulls, event.result];
        return ok({ ...state, pulls });
      }
      if (event.type === "settle_complete") {
        const debts = buildDebts(state.pulls, event.at);
        const text = settlementSummary(state.split, state.pulls, debts);
        return ok({ name: "done", receipt: state.receipt, split: state.split, pulls: state.pulls, debts }, [
          { type: "notify", text },
        ]);
      }
      return invalid(state, event);
    }

    // --- pay-after start --------------------------------------------------
    case "collecting": {
      if (event.type === "participant_in") {
        if (state.participants.includes(event.memberId)) return ok(state);
        return ok({ ...state, participants: [...state.participants, event.memberId] });
      }
      if (event.type === "participant_out") {
        return ok({
          ...state,
          participants: state.participants.filter((m) => m !== event.memberId),
        });
      }
      if (event.type === "participants_locked") {
        return ok(
          { name: "awaiting_receipt", participants: state.participants, estimate: event.estimate },
          [{ type: "notify", text: "Who paid? Send a photo of the receipt." }],
        );
      }
      return invalid(state, event);
    }

    case "awaiting_receipt": {
      if (event.type === "receipt_read") {
        const over = overByEstimate(event.receipt.total, state.estimate, event.tolerance);
        if (over !== undefined) {
          // Final is higher than the estimate by more than tolerance → re-approve.
          return ok(
            {
              name: "awaiting_approval",
              split: event.split,
              screenshot: event.screenshot,
              approvals: [],
              requiredApprovers: state.participants,
              deadline: event.deadline,
              receipt: event.receipt,
            },
            [
              {
                type: "notify",
                text: `Total came in ${formatUsdc(over)} over the estimate — 👍 to confirm your share.`,
              },
              { type: "post_preview", screenshot: event.screenshot, split: event.split },
            ],
          );
        }
        // Within tolerance: saying "I'm in" already counted as approval.
        return ok({ name: "settling", receipt: event.receipt, split: event.split, pulls: [] }, [
          { type: "pull_shares", split: event.split },
        ]);
      }
      return invalid(state, event);
    }

    // --- terminal ---------------------------------------------------------
    case "done":
    case "rejected":
    case "cancelled":
    case "failed":
    case "placing_order":
      return invalid(state, event);
  }
}

// ----------------------------------------------------------------------------
// Small pure helpers used above
// ----------------------------------------------------------------------------

export function isTerminal(state: RequestState): boolean {
  return (
    state.name === "done" ||
    state.name === "rejected" ||
    state.name === "cancelled" ||
    state.name === "failed"
  );
}

/** Returns the overage amount if `total` exceeds `estimate` by more than
 *  `tolerance`, otherwise undefined. */
function overByEstimate(total: Usdc, estimate: Usdc | undefined, tolerance: Usdc): Usdc | undefined {
  if (estimate === undefined) return undefined;
  const ceiling = (estimate + tolerance) as Usdc;
  if (gtUsdc(total, ceiling)) return subUsdc(total, estimate);
  return undefined;
}

function settlementSummary(split: Split, pulls: PullResult[], debts: Debt[]): string {
  const pulled = pulls.filter((p) => p.status === "pulled").length;
  const total = Object.keys(split.shares).length;
  if (debts.length === 0) {
    return `Settled — pulled ${pulled}/${total} shares to the payer.`;
  }
  const owed = debts
    .map((d) => `${d.memberId} owes ${formatUsdc(d.amount)} (${d.reason})`)
    .join("; ");
  return `Settled ${pulled}/${total}. Still owed: ${owed}.`;
}
