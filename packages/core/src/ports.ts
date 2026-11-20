/**
 * Ports: the interfaces the core depends on. Everything undecided (chain,
 * wallet provider, stores, LLM, funding, chat provider) plugs in here without
 * touching the state machine. This is the dependency-inversion seam.
 */

import type { Usdc } from "./money.js";
import type {
  Cart,
  CheckoutMethod,
  ImageRef,
  Member,
  Receipt,
  Screenshot,
  SpendingLimit,
} from "./types.js";

// ----------------------------------------------------------------------------
// PurchaseAdapter — one per store. Stores plug in without changing the core.
// ----------------------------------------------------------------------------

export interface BuildCartInput {
  /** Plain-language ask or a structured item list the agent resolved. */
  requestText: string;
  items?: Array<{ name: string; quantity?: number; /** The agent's guess; a real store prices it itself. */ estimateUsd?: number }>;
  /** Which account / card the order should check out against. */
  checkout: CheckoutMethod;
}

export interface PreviewResult {
  /** Checkout screenshot to post to the group chat for 👍 approval. */
  screenshot: Screenshot;
  /** The amount that will actually be charged. */
  total: Usdc;
  /** The cart as priced at preview time (may differ from buildCart if the
   *  store re-priced). */
  cart: Cart;
}

export interface PlaceOrderInput {
  cart: Cart;
  /** For a Link checkout, the treasurer's spend approval must already be done;
   *  this carries whatever token/proof the checkout layer needs. */
  checkoutAuth?: unknown;
}

/**
 * A store integration. Implementations may use an official agent API or
 * browser automation — the core does not care which. The demo store's adapter
 * MUST perform a real checkout (no mock).
 */
export interface PurchaseAdapter {
  readonly store: string;
  buildCart(input: BuildCartInput): Promise<Cart>;
  /** Produce the screenshot + final total shown to the group before approval. */
  preview(cart: Cart): Promise<PreviewResult>;
  /** Place the real order and return a receipt. */
  placeOrder(input: PlaceOrderInput): Promise<Receipt>;
}

// ----------------------------------------------------------------------------
// WalletAdapter — pulls each member's share within their limit. Swappable so
// the chain and wallet provider can change later.
// ----------------------------------------------------------------------------

/** Where a pulled share is sent (the payer). */
export type Payee =
  | { kind: "wallet"; address: string }
  | { kind: "card"; reference: string };

export interface LimitStatus {
  limit: SpendingLimit;
  /** How much of the limit remains in the current period. */
  remaining: Usdc;
  resetsAt?: number;
}

export interface PullParams {
  from: Member;
  to: Payee;
  amount: Usdc;
  /** Human-readable memo, e.g. "Dinner at Uchi — your share". */
  memo?: string;
  /** Idempotency key so a retried pull never double-charges. */
  idempotencyKey: string;
}

export interface PullOutcome {
  status: "pulled" | "failed";
  txRef?: string;
  reason?: string;
  /**
   * Auto pay-back: parts of this share that went straight to people the payee owed, clearing
   * those debts, instead of to the payee. `creditor` is a wallet address.
   */
  autoPaid?: { creditor: string; amount: Usdc }[];
}

/** An all-or-nothing group buy: `needed` people each put in `each` for `payee` by `deadline`, or nobody pays. */
export interface PoolParams {
  poolId: string;
  payee: Member;
  each: Usdc;
  needed: number;
  /** Epoch ms. */
  deadline: number;
}

export type PledgeOutcome =
  | { status: "pledged"; count: number; filled: boolean; txRef?: string }
  | { status: "failed"; reason: string };

/**
 * Moves a member's share from their own wallet to the payer, never exceeding
 * the member's recurring limit. How the limit is enforced (on-chain spend
 * permissions, a provider policy, or signed permits) is an implementation
 * detail hidden behind this interface.
 */
export interface WalletAdapter {
  readonly id: string;
  getLimitStatus(member: Member): Promise<LimitStatus>;
  /** Cheap pre-check used when building the split preview. */
  canPull(member: Member, amount: Usdc): Promise<{ ok: boolean; remaining: Usdc }>;
  pull(params: PullParams): Promise<PullOutcome>;
  /**
   * Optional: lower a member's limit right away. The bot may only lower (raising needs the
   * member's own Face ID), so implementations reject a higher amount.
   */
  lowerLimit?(member: Member, amount: Usdc): Promise<void>;
  /** Optional: the money in a member's own account (what they have, not what a chat may take). */
  balance?(member: Member): Promise<Usdc>;
  /** Optional: stop this group pulling from a member who left (their limit here becomes 0). */
  removeMember?(member: Member): Promise<void>;
  /** Optional: what `debtor` still owes `creditor` from shares that couldn't be pulled. */
  owed?(debtor: Member, creditor: Member): Promise<Usdc>;
  /**
   * Optional: settle-up netting. Rewrite the pairwise debt graph to `adds` (fewer transfers),
   * clearing `clears`, in one onchain call. Balance-preserving (no money moves, each person's net
   * is unchanged). Returns false if the deployed contract can't do it (so callers fall back to the
   * advisory plan).
   */
  netSettle?(clears: DebtEdge[], adds: DebtEdge[]): Promise<boolean>;
  /**
   * Optional: all-or-nothing group buys. Each pledge is held (never beyond the member's limit) and
   * the pot goes to the payee only when the last needed person pledges; `refundPool` gives
   * everyone their money (and limit) back.
   */
  openPool?(params: PoolParams): Promise<void>;
  pledge?(poolId: string, member: Member): Promise<PledgeOutcome>;
  refundPool?(poolId: string): Promise<void>;
}

/** A single "who owes whom" edge used by settle-up netting. */
export interface DebtEdge {
  from: Member;
  to: Member;
  amount: Usdc;
}

// ----------------------------------------------------------------------------
// ChatPort — the group chat (implemented by the Photon/iMessage adapter).
// ----------------------------------------------------------------------------

export interface MessageRef {
  id: string;
  chatId: string;
}

export interface IncomingMessage {
  chatId: string;
  /** Sender's handle as the chat provider reports it. */
  senderHandle: string;
  text: string;
  attachments: ImageRef[];
  at: number;
  /** This message's own id, so a later inline reply can be matched back to it. */
  id?: string;
  /** If this is an inline reply, the id of the message being replied to. */
  replyToMessageId?: string;
}

export interface IncomingReaction {
  chatId: string;
  senderHandle: string;
  /** The message the reaction is attached to. */
  targetMessageId: string;
  emoji: string;
  /** False when a reaction is removed. */
  added: boolean;
  at: number;
}

export type Unsubscribe = () => void;

export interface ChatPort {
  postMessage(chatId: string, text: string): Promise<MessageRef>;
  postImage(chatId: string, image: ImageRef, caption?: string): Promise<MessageRef>;
  /** One-on-one text to a member. */
  sendDirectMessage(handle: string, text: string): Promise<MessageRef>;
  onMessage(handler: (msg: IncomingMessage) => void): Unsubscribe;
  onReaction(handler: (reaction: IncomingReaction) => void): Unsubscribe;
  /** A one-on-one message to the bot (private). Used for account questions like "what's my balance?". */
  onDirectMessage(handler: (msg: IncomingMessage) => void): Unsubscribe;
  /**
   * The group chat's member handles, so the bot can consider everyone in the chat without waiting
   * for each person to speak. Returns an empty list when the roster can't be read.
   */
  getParticipants(chatId: string): Promise<string[]>;
  /** The group chat's display name (the title people gave it), or null if it has none. */
  getChatName(chatId: string): Promise<string | null>;
}

// ----------------------------------------------------------------------------
// ReceiptReader — turns a receipt photo into a structured Receipt (vision/LLM
// provider undecided).
// ----------------------------------------------------------------------------

export interface ReceiptReader {
  read(image: ImageRef): Promise<Receipt>;
}
