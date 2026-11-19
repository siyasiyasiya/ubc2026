/**
 * Shared domain types. Everything in the system builds against these.
 *
 * These are deliberately transport- and chain-agnostic: no provider, store,
 * LLM, or chain is named here. Concrete details live behind the ports in
 * `ports.ts` and their adapter implementations.
 */

import type { Usdc } from "./money.js";

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

export type GroupId = string;
export type MemberId = string;
export type RequestId = string;

// ----------------------------------------------------------------------------
// Members & groups
// ----------------------------------------------------------------------------

/** How a member's iMessage identity is addressed (phone number or email). */
export interface Handle {
  kind: "phone" | "email";
  value: string;
}

/** How often a limit refills. Weekly/monthly refill up to the limit (unspent money never left the
 *  member's account, and what can be pulled never goes above the limit). "once" is for trips: the
 *  limit never refills. */
export type LimitPeriod = "weekly" | "monthly" | "once";

/** "a week", "a month", or "for the trip", for chat text. */
export function perPeriod(period: LimitPeriod): string {
  return period === "weekly" ? "a week" : period === "monthly" ? "a month" : "in total";
}

/** The contract's `Period` enum value. */
export function periodIndex(period: LimitPeriod): 0 | 1 | 2 {
  return period === "weekly" ? 0 : period === "monthly" ? 1 : 2;
}

export function periodFromIndex(index: number): LimitPeriod {
  return index === 0 ? "weekly" : index === 1 ? "monthly" : "once";
}

/** A spending limit per group chat: refills weekly/monthly, or once for a trip.
 *  The member never approves a large total up front; the limit caps what can
 *  be pulled from them. */
export interface SpendingLimit {
  amount: Usdc;
  period: LimitPeriod;
  /** Timestamp the current period resets. Advisory in core; the WalletAdapter
   *  is the source of truth for what is actually enforceable on-chain/by policy. */
  resetsAt?: Timestamp;
}

/** How a member can pay / be paid back. Kept abstract: funding + wallet
 *  provider are not yet decided. */
export type FundingSource =
  | { kind: "wallet"; address: string }
  | { kind: "card"; last4: string; brand?: string };

export interface Member {
  id: MemberId;
  displayName: string;
  handle: Handle;
  /** Set once the member connects a wallet / completes funding. */
  wallet?: { address: string };
  /** Where this member can be paid back when they front a pay-after spend. */
  payTo?: FundingSource;
  limit: SpendingLimit;
}

export type GroupKind = "friends" | "trip" | "roommates";

export interface Group {
  id: GroupId;
  kind: GroupKind;
  name: string;
  /** iMessage group chat identifier (as seen by the chat port). */
  chatId: string;
  members: Member[];
  /** Optional on-chain group contract address. Undecided onchain pieces stay
   *  optional so the group works without them. */
  contractAddress?: string;
  /** Trips have an end date; friends/roommates are ongoing. */
  endsAt?: Timestamp;
}

// ----------------------------------------------------------------------------
// Requests, carts, splits
// ----------------------------------------------------------------------------

/** Which of the two spending flows a request follows. */
export type SpendFlow = "pay_before" | "pay_after";

/** A member's plain-language ask that kicks off a spend. */
export interface Request {
  id: RequestId;
  groupId: GroupId;
  requesterId: MemberId;
  /** The raw message text, e.g. "we're out of paper towels". */
  text: string;
  flow: SpendFlow;
  createdAt: Timestamp;
}

/** How the agent will actually check out. */
export type CheckoutMethod =
  | { kind: "store_account"; memberId: MemberId; store: string }
  | { kind: "link_card" };

export interface CartLineItem {
  name: string;
  quantity: number;
  unitPrice: Usdc;
}

/** A cart built by a PurchaseAdapter, ready to preview and order. */
export interface Cart {
  id: string;
  store: string;
  lineItems: CartLineItem[];
  subtotal: Usdc;
  tax: Usdc;
  shipping: Usdc;
  total: Usdc;
  checkout: CheckoutMethod;
}

export type SplitMethod =
  | { kind: "even" }
  | { kind: "by_item" }
  | { kind: "custom"; shares: Record<MemberId, Usdc> };

/** Each participant's share of a spend. Shares always sum to `total`. */
export interface Split {
  total: Usdc;
  method: SplitMethod;
  /** memberId -> amount owed. Only participants appear. */
  shares: Record<MemberId, Usdc>;
  /** Who fronted the money and should be paid back. For an agent order this is
   *  whoever's account/card paid; for pay-after it's whoever paid the bill. */
  payeeMemberId: MemberId;
}

// ----------------------------------------------------------------------------
// Approvals, screenshots, receipts
// ----------------------------------------------------------------------------

/** A 👍 (or other reaction) from a member on the checkout screenshot. */
export interface Approval {
  memberId: MemberId;
  emoji: string;
  at: Timestamp;
}

/** A reference to an image living wherever the chat/storage layer keeps it. */
export interface ImageRef {
  /** Opaque locator: file path, URL, or chat attachment id. */
  uri: string;
  mimeType?: string;
}

/** The checkout screenshot posted to the group before a purchase. */
export interface Screenshot {
  image: ImageRef;
  caption?: string;
}

export interface ReceiptLineItem {
  name: string;
  amount: Usdc;
}

/** A receipt, either produced by the agent's own order or parsed from a photo
 *  a member sent in the chat. */
export interface Receipt {
  source: "agent_order" | "photo";
  merchant?: string;
  subtotal?: Usdc;
  tax?: Usdc;
  tip?: Usdc;
  total: Usdc;
  lineItems?: ReceiptLineItem[];
  image?: ImageRef;
  at: Timestamp;
}

// ----------------------------------------------------------------------------
// Settlement
// ----------------------------------------------------------------------------

/** The outcome of pulling one member's share to the payer. */
export interface PullResult {
  memberId: MemberId;
  amount: Usdc;
  status: "pulled" | "failed";
  /** Transaction hash / provider reference when pulled. */
  txRef?: string;
  /** Why it failed (e.g. "over limit", "insufficient funds"). */
  reason?: string;
}

/** What a member still owes when their share could not be pulled. Mirrors the
 *  debt the group contract records on a failed pull. */
export interface Debt {
  memberId: MemberId;
  amount: Usdc;
  reason: string;
  createdAt: Timestamp;
}
