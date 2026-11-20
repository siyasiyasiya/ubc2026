/**
 * The runtime: chat events in, agent turns, core state machine transitions, effects out.
 *
 *   ChatPort ─▶ runtime ─▶ agent (Claude) ─▶ actions ─▶ transition(state, event) ─▶ effects
 *      ▲                                                                              │
 *      └────────── post card / notify ◀── WalletAdapter.pull ◀────────────────────────┘
 *
 * The agent only proposes. Whether money moves is decided here and in the state machine: every
 * participant must 👍 the card, and the WalletAdapter refuses pulls over a member's limit.
 */

import {
  APPROVAL_EMOJI,
  perPeriod,
  byItemSplit,
  customSplit,
  evenSplit,
  netTransfers,
  type Transfer,
  formatUsdc,
  initialState,
  transition,
  usdc,
  type Cart,
  type ChatPort,
  type Effect,
  type Group,
  type IncomingMessage,
  type IncomingReaction,
  type Member,
  type PurchaseAdapter,
  type Receipt,
  type ReceiptReader,
  type RequestEvent,
  type SpendingLimit,
  type Split,
  type Usdc,
  type WalletAdapter,
} from "@gta/core";
import { NotAReceiptError } from "@gta/agent";
import type { runTurn as RunTurn, runDmTurn as RunDmTurn, TreasuryActions, DmActions } from "@gta/agent";
import { groupIdForChat, inviteLink, inviteTicket, type DebtPaidEvent, type JoinEvent, type LimitSetEvent } from "@gta/wallet";
import { normalizePreferenceKey, type GroupRecord, type RequestRecord, type Store, type Subscription } from "./store.js";
import type { RestaurantCaller } from "./restaurant-call.js";
import { asPng } from "./svg-to-png.js";

export interface RuntimeDeps {
  chat: ChatPort;
  /** One adapter for every chat, or one per chat (the Arc adapter: limits are per chat onchain). */
  wallet: WalletAdapter | ((chatId: string) => WalletAdapter);
  receipts: ReceiptReader;
  /** Kitty buys things for the group (pay before). Crossmint for real orders, or a labelled simulation. */
  purchase?: PurchaseAdapter;
  /** Testnet only: send test dollars to an account (the operator's faucet). Off in production. */
  testMoney?: { send: (address: string, amount: Usdc) => Promise<string>; maxUsd: number; dailyUsd: number };
  /** Kitty phones restaurants (ElevenLabs voice agent). Off when unset. */
  calls?: RestaurantCaller;
  /** How often to check on a call in progress. Default 5s. */
  callPollMs?: number;
  runTurn: typeof RunTurn;
  /** The private-DM brain: answers a member's account questions one-on-one. */
  runDmTurn: typeof RunDmTurn;
  store: Store;
  defaultLimit: SpendingLimit;
  /** Display names by handle, e.g. { "+18475551234": "Tristan" }. */
  names: Record<string, string>;
  /** Kitty account (wallet) address by handle from config. The Face ID join watcher fills in the rest. */
  wallets?: Record<string, string>;
  /** Face ID invite links: the page's URL and the secret tickets are derived from. */
  invites?: { baseUrl: string; secret: string };
  /** Chats the bot serves (ALLOWED_CHAT_IDS), so a CLI invite to a chat it hasn't seen still matches. */
  chats?: string[];
  /**
   * Keeps each member's balance equal to what their kitties can take this period (see
   * topUpBalances). "send": testnet, Kitty sends the difference itself, up to `dailyUsd` per account
   * a day. "remind": real money, which only the member can add, so Kitty texts a one-tap top-up link.
   */
  autoTopUp?: { mode: "send"; send: (address: string, amount: Usdc) => Promise<string>; dailyUsd: number } | { mode: "remind" };
  /**
   * Members' own cards for store buys (Crossmint). `linkFor` makes a private save-card link (valid
   * an hour); the page hands the card id back by a prefilled text to Kitty. `purchaseFor` is a store
   * adapter that checks out and charges as that member, so a buy goes on the payer's own card.
   */
  cards?: {
    userIdFor(handle: string): string;
    linkFor(handle: string, name: string): string;
    purchaseFor?(card: { userId: string; paymentMethodId: string }): PurchaseAdapter;
  };
  /**
   * Turns a long page link into a short one whose iMessage card says what it's for ("Join Tahoe
   * trip · $200 each" / "Tap to confirm") instead of one big generic banner. Unset: links go out long.
   */
  shortLink?: (url: string, card: { title: string; sub: string }) => Promise<string>;
  /** Demo only (SUBSCRIPTION_EVERY_MIN): charge subscriptions this often instead of weekly/monthly. */
  subscriptionEveryMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * One subscription for the web page's dashboard, as a link param (the page has no backend):
 * `group~every~status~total~myShare~nextAtSeconds~payeeAddress~payeeName~title`. Amounts are USDC
 * base units; the title goes last so it may contain anything. The payee's address lets the page
 * name that subscription's charges in the chain history. My share is 0 when I'm the one paid.
 */
export function subscriptionParam(group: string, sub: Subscription, viewer: string, payee?: Member): string {
  const mine = viewer === sub.split.payeeMemberId ? 0n : (sub.split.shares[viewer] ?? 0n);
  const next = sub.nextAt ? Math.floor(sub.nextAt / 1000) : 0;
  const clean = (text: string) => text.replace(/~/g, "-");
  return [group, sub.every, sub.status === "active" ? "a" : "p", sub.split.total, mine, next, payee?.wallet?.address ?? "-", clean(payee?.displayName ?? "-"), sub.title].join("~");
}

/** The next charge after `from`: a week later, or the same day next month (the 31st clamps to the month's end). */
export function nextCharge(from: number, every: "weekly" | "monthly", overrideMs?: number): number {
  if (overrideMs) return from + overrideMs;
  if (every === "weekly") return from + 7 * 24 * 60 * 60 * 1000;
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

const HISTORY_LINES = 30;
const CENT = 10_000n as Usdc;
const roundUpToCent = (amount: Usdc) => (((amount + CENT - 1n) / CENT) * CENT) as Usdc;
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPROVE_WORDS = new Set([APPROVAL_EMOJI, "like", "liked", "thumbsup", "+1"]);

/** "p:0/GUID" and "GUID" refer to the same message; compare on the bare id. */
function sameMessage(a: string, b: string): boolean {
  const bare = (id: string) => id.replace(/^p:\d+\//, "").split(":")[0] ?? id;
  return bare(a) === bare(b);
}

/** A member we only know by handle shows as "…1234" until they tell us their name. */
function hasRealName(member: Member): boolean {
  return !member.displayName.startsWith("…");
}

/** A short reply that reads like a name ("Dana", "it's dana!", "Dana P"), else undefined. */
const NOT_NAMES = new Set(["what", "who", "why", "how", "huh", "ok", "okay", "yes", "yeah", "no", "nope", "sure", "lol", "hi", "hey", "hello", "thanks", "ty"]);

export function nameFromReply(text: string): string | undefined {
  if (text.includes("?")) return undefined; // a question back, not a name
  const cleaned = text
    .trim()
    .replace(/^(hi|hey|hello|yo)[,!\s]+/i, "")
    .replace(/^(i'?m|im|it'?s|its|my name is|call me|this is)\s+/i, "")
    .replace(/[.!?,🙂😊👋]+$/u, "")
    .trim();
  if (!cleaned || cleaned.length > 30 || /[@/:]|\d/.test(cleaned) || cleaned.split(/\s+/).length > 3) return undefined;
  if (NOT_NAMES.has(cleaned.split(/\s+/)[0]!.toLowerCase())) return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** "+1 (512) 555-0100", "512-555-0100" → "+15125550100"; US numbers without a country code get +1. */
export function toE164(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, "");
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith("1")) return `+${bare}`;
  return undefined;
}

/** "resets in 3 days" / "resets in 5 hours" / "never refills" (one-time), for the DM summary. */
export function resetsIn(limit: SpendingLimit, resetsAt: number | undefined, now: number): string {
  if (limit.period === "once") return "never refills";
  if (!resetsAt) return "";
  const ms = resetsAt - now;
  if (ms <= 0) return "resets now";
  if (ms >= 86_400_000) {
    const days = Math.ceil(ms / 86_400_000);
    return `resets in ${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return `resets in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Contract reasons in words members understand. */
function plainReason(reason: string | undefined): string {
  if (reason === "transfer failed") return "not enough in their Kitty account";
  if (reason === "over limit") return "over their limit";
  if (reason === "payer hasn't linked a wallet yet") return "the payer isn't set up in Kitty yet";
  if (reason === "hasn't linked a wallet yet" || reason === "hasn't joined this chat's treasury") return "not set up in Kitty yet";
  if (reason?.startsWith("Arc error")) return "couldn't reach the network, try again";
  return reason ?? "failed";
}

/** Pick a random variant so the chain-driven status lines don't read like the same template every time. */
function pick<T>(variants: readonly T[]): T {
  return variants[Math.floor(Math.random() * variants.length)]!;
}

export class GroupRuntime {
  private readonly history = new Map<string, string[]>();
  /** Recent messages by id (incoming and Kitty's own), so an inline reply can quote what it points at. */
  private readonly repliable = new Map<string, string>();
  /** The last receipt each group posted, attached to the next proposal that matches its total. */
  private readonly lastReceipt = new Map<string, Receipt>();
  /** Requests being set up right now: the payer and amount are known, so skip the state machine's "Who paid?". */
  private readonly starting = new Set<string>();
  /** Test dollars sent per account today, so one person can't drain the bot's testnet wallet. */
  private readonly testMoneySent = new Map<string, { day: string; usd: number }>();
  /** Store work (shopping, placing an order) runs outside the queue so a slow store can't stall the chat. */
  private readonly background = new Set<Promise<void>>();
  /** Chats whose roster we've already pulled from the chat port, so we seed members once per chat. */
  private readonly seededRosters = new Set<string>();
  /** Nudge keys already sent, so a reminder fires once per item per process run. */
  private readonly nudged = new Set<string>();
  /** Auto top-ups sent today per account, and the days a top-up reminder already went out. */
  private readonly autoTopUpSent = new Map<string, { day: string; amount: Usdc }>();
  private readonly topUpReminded = new Set<string>();
  /** Store adapters for buys on a member's own card, by request id. */
  private readonly purchases = new Map<string, PurchaseAdapter>();
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(`[runtime] ${line}`));
  }

  /** Subscribes to the chat port. */
  attach(): void {
    this.deps.chat.onMessage((msg) => void this.serial(() => this.handleMessage(msg)));
    this.deps.chat.onReaction((r) => void this.serial(() => this.handleReaction(r)));
    this.deps.chat.onDirectMessage((msg) => void this.serial(() => this.handleDirectMessage(msg)));
  }

  /** Handles events one at a time so two messages can't race on the same state. Resolves when done. */
  serial(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.log(`error: ${(err as Error).stack ?? err}`));
    return this.queue;
  }

  /** Resolves once background store work and the queue are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
    await this.queue;
  }

  private inBackground(task: () => Promise<void>): void {
    const done: Promise<void> = task()
      .catch((err) => this.log(`error: ${(err as Error).stack ?? err}`))
      .finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** Like `serial`, but the caller gets the result or the error (the queue still carries on). */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      (err) => this.log(`error: ${(err as Error).stack ?? err}`),
    );
    return result;
  }

  // --- groups and members ---------------------------------------------------

  private groupFor(chatId: string): GroupRecord {
    let record = this.deps.store.get(chatId);
    if (!record) {
      const group: Group = { id: chatId, kind: "friends", name: "Group", chatId, members: [] };
      record = { group, requests: [] };
      this.deps.store.put(record);
    }
    return record;
  }

  /** Anyone who talks in the group becomes a member with the default limit. Member id = handle. */
  private memberFor(record: GroupRecord, handle: string): Member {
    let member = record.group.members.find((m) => m.id === handle);
    if (!member) {
      member = {
        id: handle,
        displayName: this.deps.names[handle] ?? `…${handle.slice(-4)}`,
        handle: { kind: handle.includes("@") ? "email" : "phone", value: handle },
        limit: { ...(record.plan ?? this.deps.defaultLimit) },
      };
      record.group.members.push(member);
    }
    // Config only fills a gap; an account linked through a Face ID join wins.
    const address = this.deps.wallets?.[handle];
    if (address && !member.wallet) member.wallet = { address };
    return member;
  }

  private walletFor(record: GroupRecord): WalletAdapter {
    const { wallet } = this.deps;
    return typeof wallet === "function" ? wallet(record.group.chatId) : wallet;
  }

  private name(record: GroupRecord, memberId: string): string {
    return record.group.members.find((m) => m.id === memberId)?.displayName ?? memberId;
  }

  private resolve(record: GroupRecord, nameOrHandle: string): Member {
    const needle = nameOrHandle.trim().toLowerCase();
    const member = record.group.members.find(
      (m) => m.id.toLowerCase() === needle || m.displayName.toLowerCase() === needle,
    );
    if (!member) {
      const names = record.group.members.map((m) => m.displayName).join(", ");
      throw new Error(`No member called "${nameOrHandle}". Members: ${names}`);
    }
    return member;
  }

  // --- Face ID onboarding ----------------------------------------------------

  /** A fresh Face ID link that lets `handle` join this chat's kitty (each call is a new ticket). */
  inviteLinkFor(chatId: string, handle: string): string {
    const invites = this.deps.invites;
    if (!invites) throw new Error("Invites aren't configured (set INVITE_SECRET).");
    const record = this.groupFor(chatId);
    const member = this.memberFor(record, handle);
    const nonces = (record.inviteNonces ??= {});
    const nonce = handle in nonces ? nonces[handle]! + 1 : 0;
    nonces[handle] = nonce;
    this.deps.store.save();
    return inviteLink({
      baseUrl: invites.baseUrl,
      secret: invites.secret,
      chatId,
      chatName: this.chatLabel(record, handle),
      handle,
      displayName: member.displayName,
      nonce,
      // Only an amount the chat chose rides in the link; never the server's placeholder default.
      ...(record.plan ? { limit: record.plan } : {}),
    });
  }

  /** Texts `member` their Face ID join link. Already set up: says so instead. */
  async sendJoinLink(record: GroupRecord, member: Member): Promise<string> {
    if (member.wallet) return `${member.displayName} already has a Kitty account here.`;
    if (!record.plan) {
      return "No link sent: this chat has no plan yet. Ask the group whether it's a trip (one-time limit) or weekly/monthly, and how much each, then call set_group_plan and send the link.";
    }
    if (!hasRealName(member)) {
      // Ask privately, never in the group; the link follows once they answer (handleDirectMessage).
      record.awaitingName = [...new Set([...(record.awaitingName ?? []), member.id])];
      this.deps.store.save();
      await this.deps.chat.sendDirectMessage(
        member.id,
        `hey! it's kitty 🐱 i'm setting you up for ${record.group.name}'s kitty. what should i call you? just reply with your name`,
      );
      return "Texted them privately asking for their name; their Face ID link goes out as soon as they answer. Don't ask for it in the group.";
    }
    const link = await this.cardLink(
      this.withChats(new URL(this.inviteLinkFor(record.group.chatId, member.id)), member.id),
      `Join ${record.group.name} · ${formatUsdc(record.plan.amount)} ${record.plan.period === "once" ? "each" : perPeriod(record.plan.period)}`,
    );
    const where = await this.dm(record, member, `you're invited to ${record.group.name}'s kitty 🎉 one tap and you're set up: ${link}`);
    return where === "dm"
      ? `Texted ${member.displayName} a private Face ID link.`
      : `Couldn't text ${member.displayName} privately, so the link went in the group.`;
  }

  /**
   * Lowering applies onchain right away (the bot may only lower). Raising, or switching between
   * weekly and monthly, needs the member's own Face ID, so they get a link with the amount filled in.
   */
  private async setLimit(record: GroupRecord, member: Member, limit: SpendingLimit): Promise<string> {
    const wallet = this.walletFor(record);
    if (!member.wallet || !wallet.lowerLimit) {
      member.limit = limit;
      return member.wallet
        ? `${member.displayName}'s ${limit.period} limit is now ${formatUsdc(limit.amount)}.`
        : `Saved. ${member.displayName} isn't set up yet, so send_join_link first; they'll confirm the limit with Face ID.`;
    }
    const current = (await wallet.getLimitStatus(member)).limit;
    if (current.period === limit.period && limit.amount <= current.amount) {
      await wallet.lowerLimit(member, limit.amount);
      member.limit = { ...limit };
      return `Lowered ${member.displayName}'s ${limit.period} limit to ${formatUsdc(limit.amount)}. It applies now.`;
    }
    const where = await this.dm(
      record,
      member,
      `tap to confirm your new ${record.group.name} limit: ${await this.cardLink(
        this.pageLink(record, member, { l: formatUsdc(limit.amount).replace("$", ""), p: limit.period }),
        `Raise your ${record.group.name} limit to ${formatUsdc(limit.amount)} ${perPeriod(limit.period)}`,
      )}`,
    );
    return `Raising needs ${member.displayName}'s Face ID, so I ${where === "dm" ? "texted them" : "posted"} a link to confirm.`;
  }

  /** A short link with its own iMessage card, or the long one if shortening is off or fails (a link must always go out). */
  private async cardLink(url: string, title: string, sub = "Tap to confirm"): Promise<string> {
    if (!this.deps.shortLink) return url;
    try {
      return await this.deps.shortLink(url, { title, sub });
    } catch (err) {
      this.log(`short link failed (${(err as Error).message}), sending the long one`);
      return url;
    }
  }

  /** Sends `text` to `member` privately, or posts it in the group if a DM fails. */
  private async dm(record: GroupRecord, member: Member, text: string): Promise<"dm" | "group"> {
    try {
      await this.deps.chat.sendDirectMessage(member.id, text);
      return "dm";
    } catch (err) {
      this.log(`DM to ${member.displayName} failed (${(err as Error).message}), posting in the group`);
      await this.say(record.group.chatId, `${member.displayName}: ${text}`);
      return "group";
    }
  }

  /** A Face ID page link for this chat with extra query params (no ticket: limit or pay-back mode). */
  private pageLink(record: GroupRecord, member: Member, extra: Record<string, string>): string {
    const base = this.deps.invites?.baseUrl;
    if (!base) throw new Error("The Face ID page isn't configured (set ONBOARD_URL).");
    const url = new URL(base);
    url.searchParams.set("g", groupIdForChat(record.group.chatId));
    url.searchParams.set("c", this.chatLabel(record, member.id));
    url.searchParams.set("n", member.displayName);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return this.withChats(url, member.id);
  }

  /**
   * What this person calls the chat on the web page: its iMessage name, or for an unnamed group
   * text (most of them) the other people in it, the way Messages does ("Joey & Siya").
   */
  private chatLabel(record: GroupRecord, viewer: string): string {
    const name = record.group.name.trim();
    if (name && name !== "Group") return name;
    // "…1234" is a member Kitty hasn't learned a name for yet: not worth showing.
    const names = record.group.members
      .filter((m) => m.id !== viewer && !m.displayName.startsWith("…"))
      .map((m) => m.displayName.trim().split(/\s+/)[0]!)
      .filter(Boolean);
    if (names.length === 0) return name || "Group";
    if (names.length === 1) return names[0]!;
    if (names.length <= 3) return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
    return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
  }

  /** Adds `k=<group id>:<chat name>` for every chat this person has joined, for the page's snapshot. */
  private withChats(url: URL, handle: string): string {
    const current = url.searchParams.get("g")?.toLowerCase();
    for (const { record, member } of this.membershipsOf(handle)) {
      const group = groupIdForChat(record.group.chatId);
      if (member.wallet && group.toLowerCase() !== current) url.searchParams.append("k", `${group}:${this.chatLabel(record, handle)}`);
      for (const sub of this.subscriptions(record)) {
        if (sub.status === "cancelled" || !(member.id in sub.split.shares)) continue;
        url.searchParams.append("s", subscriptionParam(group, sub, member.id, this.payeeOf(record, sub)));
      }
    }
    // The list above is complete: the page replaces what it remembered (a stopped one disappears).
    url.searchParams.set("sv", "1");
    return url.toString();
  }

  private payeeOf(record: GroupRecord, sub: Subscription): Member | undefined {
    return record.group.members.find((m) => m.id === sub.split.payeeMemberId);
  }

  /** Settles everything approved and waiting on the tab. */
  private async settleUp(record: GroupRecord): Promise<string> {
    const waiting = record.requests.filter((r) => r.onTab && r.state.name === "settling");
    const pending = record.requests.filter((r) => r.onTab && r.state.name === "awaiting_approval").map((r) => `#${r.number}`);
    if (waiting.length === 0) {
      return pending.length ? `Nothing approved on the tab yet (${pending.join(", ")} still need 👍s).` : "The tab is empty.";
    }
    for (const request of waiting) {
      if (request.state.name !== "settling") continue;
      request.onTab = false;
      await this.pullShares(record, request, request.state.split);
    }
    this.deps.store.save();
    const left = pending.length ? ` Still waiting on 👍s: ${pending.join(", ")}.` : "";
    return `Settled ${waiting.length} from the tab.${left}`;
  }

  /** The member leaves this chat's Kitty: the contract stops anything more being pulled here. */
  private async leave(record: GroupRecord, member: Member): Promise<string> {
    if (!member.wallet) return `${member.displayName} isn't set up in this chat's Kitty.`;
    await this.walletFor(record).removeMember?.(member);
    delete member.wallet;
    member.limit = { ...(record.plan ?? this.deps.defaultLimit) };
    this.deps.store.save();
    return `${member.displayName} left. Nothing more can be taken from them in this chat; anything they already owe stays owed. They can rejoin anytime.`;
  }

  /** A `LimitSet` event. The member's own Face ID change gets a short confirmation (amounts stay private). */
  async handleLimitSet(event: LimitSetEvent): Promise<void> {
    for (const record of this.deps.store.all()) {
      if (groupIdForChat(record.group.chatId) !== event.group) continue;
      const member = record.group.members.find((m) => m.wallet?.address.toLowerCase() === event.account.toLowerCase());
      if (!member) continue;
      const changed = member.limit.amount !== event.limit.amount || member.limit.period !== event.limit.period;
      member.limit = { ...event.limit };
      this.deps.store.save();
      if (changed && event.by.toLowerCase() === event.account.toLowerCase()) {
        await this.say(
          record.group.chatId,
          pick([
            `${member.displayName}'s limit is updated ✅`,
            `done, ${member.displayName}'s new limit is live`,
            `${member.displayName} just tweaked their limit`,
            `limit updated for ${member.displayName} ✅`,
          ]),
        );
      }
    }
  }

  /** A `DebtPaid` event: tell the chat the two people share. */
  async handleDebtPaid(event: DebtPaidEvent): Promise<void> {
    const is = (m: Member, a: string) => m.wallet?.address.toLowerCase() === a.toLowerCase();
    for (const record of this.deps.store.all()) {
      const debtor = record.group.members.find((m) => is(m, event.debtor));
      const creditor = record.group.members.find((m) => is(m, event.creditor));
      if (!debtor || !creditor) continue;
      await this.say(
        record.group.chatId,
        pick([
          `${debtor.displayName} squared up with ${creditor.displayName} (${formatUsdc(event.amount)}) 🤝`,
          `${debtor.displayName} paid ${creditor.displayName} back ${formatUsdc(event.amount)}, nice`,
          `${formatUsdc(event.amount)} from ${debtor.displayName} to ${creditor.displayName}, settled`,
          `${debtor.displayName} got ${creditor.displayName} their ${formatUsdc(event.amount)} back ✅`,
        ]),
      );
      return;
    }
  }

  /**
   * A `Joined` event from the contract: find whose ticket it is, link their Kitty account and the
   * limit they signed, and say so in the chat. Returns who joined, or undefined for a ticket we
   * didn't issue. Safe to call twice for the same event (the watcher retries a failed window).
   *
   * Known limit: a ticket isn't bound to an account, so whoever submits it first (say, from a
   * forwarded link) is linked. Binding needs the server to sign each join for the joining account.
   */
  async handleJoin(event: JoinEvent): Promise<{ chatId: string; handle: string } | undefined> {
    const secret = this.deps.invites?.secret;
    if (!secret) return undefined;
    const chatIds = new Set([...this.deps.store.all().map((r) => r.group.chatId), ...(this.deps.chats ?? [])]);
    for (const chatId of chatIds) {
      if (groupIdForChat(chatId) !== event.group) continue;
      const record = this.groupFor(chatId);
      // Members the bot has seen, plus known names (CLI invites before someone has spoken).
      const handles = new Set([...record.group.members.map((m) => m.id), ...Object.keys(this.deps.names)]);
      const handle = [...handles].find((h) => {
        const latest = record.inviteNonces?.[h] ?? 0;
        for (let n = 0; n <= latest; n++) if (inviteTicket(secret, chatId, h, n) === event.ticket) return true;
        return false;
      });
      if (!handle) continue;
      const member = this.memberFor(record, handle);
      const already = member.wallet?.address.toLowerCase() === event.account.toLowerCase();
      if (!already) {
        this.log(`${member.displayName} joined ${chatId} with ${event.account}`);
        // Post before saving: if the post throws, the watcher retries and this member still looks new.
        // Limits stay private (they're set in the member's own Face ID page), so don't post the amount.
        await this.say(
          chatId,
          pick([
            `${member.displayName}'s in 🎉`,
            `welcome ${member.displayName}, you're all set`,
            `boom, ${member.displayName} just joined`,
            `${member.displayName}'s in the kitty now ✅`,
          ]),
        );
      }
      member.wallet = { address: event.account };
      member.limit = { ...event.limit };
      this.deps.store.save();
      // Joined for a subscription: the card step is next in their setup.
      const inSub = this.subscriptions(record).some((s) => s.status !== "cancelled" && handle in s.split.shares);
      if (!already && inSub && !this.deps.store.card(handle) && this.deps.cards) await this.sendCardLink(member, record);
      return { chatId, handle };
    }
    this.log(`join with unknown ticket ${event.ticket.slice(0, 10)}… from ${event.account}`);
    return undefined;
  }

  // --- chat -----------------------------------------------------------------

  private remember(chatId: string, line: string): void {
    const lines = this.history.get(chatId) ?? [];
    lines.push(line);
    if (lines.length > HISTORY_LINES) lines.splice(0, lines.length - HISTORY_LINES);
    this.history.set(chatId, lines);
  }

  private async say(chatId: string, text: string): Promise<string> {
    this.remember(chatId, `Treasury: ${text}`);
    const ref = await this.deps.chat.postMessage(chatId, text);
    this.rememberRepliable(ref.id, `Kitty: ${text}`);
    return ref.id;
  }

  /** Keep a bounded id -> "Who: text" map so an inline reply can be resolved to what it points at. */
  private rememberRepliable(id: string | undefined, line: string): void {
    if (!id) return;
    this.repliable.set(id, line);
    if (this.repliable.size > 1000) this.repliable.delete(this.repliable.keys().next().value!);
  }

  /**
   * Post an agent reply as one iMessage, or several when it separates parts with a line of "---"
   * (used for buy options, so each description and each link lands as its own text). Posts in order.
   */
  private async sayReply(chatId: string, reply: string): Promise<void> {
    const parts = reply
      .split(/^\s*---\s*$/m)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) await this.say(chatId, part);
  }

  /**
   * Seed every participant of a chat as a member the first time we act in it, so the agent
   * considers the whole group without waiting for each person to speak. Members start unlinked
   * (no wallet); the Face ID join still gates whether money can move for them.
   */
  private async ensureRoster(record: GroupRecord): Promise<void> {
    const chatId = record.group.chatId;
    if (this.seededRosters.has(chatId)) return;
    this.seededRosters.add(chatId);
    try {
      const name = await this.deps.chat.getChatName(chatId);
      if (name && name !== record.group.name) {
        record.group.name = name;
        this.deps.store.save();
      }
      const handles = await this.deps.chat.getParticipants(chatId);
      for (const handle of handles) this.memberFor(record, handle);
      if (handles.length) {
        this.deps.store.save();
        this.log(`seeded ${handles.length} member(s) from the roster of ${chatId}${name ? ` ("${name}")` : ""}`);
      }
    } catch (err) {
      this.seededRosters.delete(chatId); // a later event retries
      this.log(`couldn't read the roster for ${chatId}: ${(err as Error).message}`);
    }
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const record = this.groupFor(msg.chatId);
    await this.ensureRoster(record);
    const member = this.memberFor(record, msg.senderHandle);

    // A bare 👍 text approves the sender's most recent card (fallback if tapbacks don't come through).
    if (msg.attachments.length === 0 && APPROVE_WORDS.has(msg.text.trim().toLowerCase())) {
      const open = [...record.requests]
        .reverse()
        .find(
          (r) => r.state.name === "awaiting_approval" && r.state.requiredApprovers.includes(member.id),
        );
      if (open) {
        this.remember(msg.chatId, `${member.displayName}: ${msg.text}`);
        await this.apply(record, open, { type: "reaction", memberId: member.id, emoji: APPROVAL_EMOJI, added: true, at: this.now() });
        this.deps.store.save();
        return;
      }
    }

    // If this is an inline reply, quote what it points at so "this one" / "yeah that" is unambiguous.
    const repliedTo = msg.replyToMessageId ? this.repliable.get(msg.replyToMessageId) : undefined;
    const who = repliedTo ? `${member.displayName} (replying to “${repliedTo}”)` : member.displayName;
    let event = msg.text ? `${who}: ${msg.text}` : "";
    this.rememberRepliable(msg.id, `${member.displayName}: ${msg.text || "[photo]"}`);
    const image = msg.attachments[0];
    if (image) {
      try {
        const receipt = await this.deps.receipts.read(image);
        this.lastReceipt.set(msg.chatId, receipt);
        // Number items (1-based) so "split by item" claims line up with the lineItems order.
        const items = (receipt.lineItems ?? []).map((i, n) => `${n + 1}. ${i.name} ${formatUsdc(i.amount)}`).join("; ");
        event =
          `[${member.displayName} posted a receipt from ${receipt.merchant ?? "unknown"}: ` +
          `subtotal ${formatUsdc(receipt.subtotal ?? usdc(0))}, tax ${formatUsdc(receipt.tax ?? usdc(0))}, ` +
          `tip ${formatUsdc(receipt.tip ?? usdc(0))}, total ${formatUsdc(receipt.total)}. Items: ${items || "not listed"}]`;
      } catch (err) {
        if (err instanceof NotAReceiptError) {
          event = `[${member.displayName} posted a file that isn't a receipt]`;
        } else {
          // A technical failure (couldn't open the file, converter or vision call errored), not a
          // verdict that it's not a receipt. Log loudly and tell the agent so it asks for a resend.
          this.log(`receipt read failed on ${image.mimeType ?? "file"} ${image.uri}: ${(err as Error).message}`);
          event = `[${member.displayName} posted an image but Kitty couldn't open it this time]`;
        }
      }
    }
    if (!event) return;

    const history = [...(this.history.get(msg.chatId) ?? [])];
    this.remember(msg.chatId, event);
    const reply = await this.deps.runTurn({
      groupSnapshot: await this.snapshot(record),
      history,
      senderName: member.displayName,
      event,
      actions: this.actionsFor(record, member),
    });
    if (reply) await this.sayReply(msg.chatId, reply);
    this.deps.store.save();
  }

  // --- private DMs ("what's my balance?") -----------------------------------

  /** Every group the person (by handle) is a member of, with their own Member object in each. */
  private membershipsOf(handle: string): { record: GroupRecord; member: Member }[] {
    const out: { record: GroupRecord; member: Member }[] = [];
    for (const record of this.deps.store.all()) {
      const member = record.group.members.find((m) => m.id === handle);
      if (member) out.push({ record, member });
    }
    return out;
  }

  /** The person's account across their chats: one global balance, plus each chat's limit and remaining. */
  private async accountSummary(handle: string, memberships: { record: GroupRecord; member: Member }[]): Promise<string> {
    const name = memberships[0]?.member.displayName ?? this.deps.names[handle] ?? `…${handle.slice(-4)}`;
    const anyWallet = memberships.find((m) => m.member.wallet);
    let balanceLine = "Balance: not set up yet (no Kitty account)";
    if (anyWallet) {
      const bal = await this.walletFor(anyWallet.record).balance?.(anyWallet.member);
      balanceLine = bal === undefined ? "Balance: unknown" : `Balance: ${formatUsdc(bal)} in their Kitty account (shared across all their groups)`;
    }
    const groups = await Promise.all(
      memberships.map(async ({ record, member }) => {
        const status = await this.walletFor(record).getLimitStatus(member);
        const limit = status.limit.amount > 0n ? status.limit : member.limit;
        const per = limit.period === "once" ? "in total (one time)" : `per ${limit.period === "weekly" ? "week" : "month"}`;
        const resets = resetsIn(limit, status.resetsAt ?? status.limit.resetsAt, this.now());
        const activity = this.recentActivity(record, member.id, 5);
        const history = activity.length ? `\n     recent: ${activity.map((l) => l.replace(/^- /, "")).join(" | ")}` : "";
        const subs = this.subscriptions(record)
          .filter((s) => s.status === "active" && member.id in s.split.shares && member.id !== s.split.payeeMemberId)
          .map((s) => `${s.title} ${formatUsdc(s.split.shares[member.id]!)} ${s.every}`);
        const subLine = subs.length ? `\n     subscriptions (their share, charged automatically): ${subs.join(" | ")}` : "";
        return `- ${record.group.name}: ${formatUsdc(status.remaining)} left of a ${formatUsdc(limit.amount)} limit ${per}${resets ? `, ${resets}` : ""}${subLine}${history}`;
      }),
    );
    return `Person: ${name}\n${balanceLine}\n\nTheir groups (and their recent transactions in each, across all their chats):\n${groups.join("\n") || "- (none yet)"}`;
  }

  private async handleDirectMessage(msg: IncomingMessage): Promise<void> {
    if (await this.takeName(msg)) return;
    if (await this.takeCard(msg)) return;
    const handle = msg.senderHandle;
    const memberships = this.membershipsOf(handle);
    const name = memberships[0]?.member.displayName ?? this.deps.names[handle] ?? `…${handle.slice(-4)}`;
    const dmKey = `dm:${handle}`;

    if (memberships.length === 0) {
      await this.sendDm(handle, dmKey, name, "I don't see you in any Kitty group yet, so there's no account to check. Ask to join in your group chat first.");
      return;
    }

    const history = [...(this.history.get(dmKey) ?? [])];
    this.remember(dmKey, `${name}: ${msg.text}`);
    const reply = await this.deps.runDmTurn({
      accountSummary: await this.accountSummary(handle, memberships),
      history,
      personName: name,
      event: msg.text,
      actions: this.dmActionsFor(handle, dmKey, name, memberships),
    });
    if (reply) await this.sendDm(handle, dmKey, name, reply);
  }

  /**
   * The reply to "what should I call you?": save the name everywhere this person is a member, then
   * send each waiting group's Face ID link. Returns false when no name question is pending.
   */
  /**
   * "my kitty card: pm_… (visa ending 4242)": the save-card page's prefilled text. The id alone can't
   * charge anything (charges need this member's own signed token), so taking it from their own
   * thread is safe.
   */
  private async takeCard(msg: IncomingMessage): Promise<boolean> {
    const match = /my kitty card:\s*([A-Za-z0-9_.:-]{6,100})(?:\s*\(([^)]{1,60})\))?/i.exec(msg.text);
    if (!match || !this.deps.cards) return false;
    const handle = msg.senderHandle;
    const label = match[2]?.trim();
    this.deps.store.saveCard(handle, { userId: this.deps.cards.userIdFor(handle), paymentMethodId: match[1]!, ...(label ? { label } : {}), at: this.now() });
    this.deps.store.save();
    const name = this.membershipsOf(handle)[0]?.member.displayName ?? this.deps.names[handle] ?? "";
    await this.sendDm(handle, `dm:${handle}`, name, `saved${label ? ` your ${label}` : " your card"} ✓ when Kitty buys something and you're the one paying, it goes on this card, only after everyone 👍s.`);
    return true;
  }

  /** Texts a member their private save-card link. */
  private async sendCardLink(member: Member, record?: GroupRecord): Promise<string> {
    if (!this.deps.cards) return "Saving cards isn't set up on this bot.";
    const link = await this.cardLink(this.deps.cards.linkFor(member.id, member.displayName), "Save your card for group buys", "Only charged after everyone 👍s");
    const text = `save the card you'd pay with when Kitty buys stuff for the group. it's only charged after everyone 👍s, and card details go straight to Crossmint, never Kitty (link works for an hour): ${link}`;
    if (record) await this.dm(record, member, text);
    else await this.sendDm(member.id, `dm:${member.id}`, member.displayName, text);
    return `Texted ${member.displayName} a private link to save their card.`;
  }

  private async takeName(msg: IncomingMessage): Promise<boolean> {
    const handle = msg.senderHandle;
    const waiting = this.deps.store.all().filter((r) => r.awaitingName?.includes(handle));
    if (waiting.length === 0) return false;
    const name = nameFromReply(msg.text);
    if (!name) {
      await this.deps.chat.sendDirectMessage(handle, "just your first name is perfect 🙂");
      return true;
    }
    for (const record of this.membershipsOf(handle).map((m) => m.record)) {
      const member = record.group.members.find((m) => m.id === handle);
      if (member) member.displayName = name;
    }
    for (const record of waiting) {
      record.awaitingName = record.awaitingName!.filter((h) => h !== handle);
      const member = this.memberFor(record, handle);
      member.displayName = name;
      const link = this.inviteLinkFor(record.group.chatId, handle);
      await this.deps.chat.sendDirectMessage(handle, `nice to meet you, ${name}! one Face ID tap and you're in ${record.group.name}'s kitty: ${link}`);
    }
    this.deps.store.save();
    this.log(`${handle} is now "${name}"`);
    return true;
  }

  /** Testnet: send test dollars to this person's Kitty account, within the per-request and daily caps. */
  private async addTestMoney(memberships: { record: GroupRecord; member: Member }[], usd: number): Promise<string> {
    const testMoney = this.deps.testMoney!;
    const linked = memberships.find((m) => m.member.wallet);
    if (!linked) return "They don't have a Kitty account yet. Tell them to join in their group chat first.";
    const address = linked.member.wallet!.address;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const sent = this.testMoneySent.get(address.toLowerCase());
    const today = sent?.day === day ? sent.usd : 0;
    const amount = Math.min(Math.round(usd * 100) / 100, testMoney.maxUsd, testMoney.dailyUsd - today);
    if (amount <= 0) return `They already got $${today} of test money today (limit $${testMoney.dailyUsd}). Try again tomorrow.`;
    await testMoney.send(address, usdc(amount));
    this.testMoneySent.set(address.toLowerCase(), { day, usd: today + amount });
    const balance = await this.walletFor(linked.record).balance?.(linked.member);
    this.log(`test money: $${amount} to ${address}`);
    return `Added $${amount} of test money.${balance === undefined ? "" : ` Their balance is now ${formatUsdc(balance)}.`}${amount < usd ? ` (Capped: $${testMoney.maxUsd} per request, $${testMoney.dailyUsd} a day.)` : ""}`;
  }

  /** Sends a DM reply and records it in the DM history. */
  private async sendDm(handle: string, dmKey: string, _name: string, text: string): Promise<void> {
    this.remember(dmKey, `Kitty: ${text}`);
    try {
      await this.deps.chat.sendDirectMessage(handle, text);
    } catch (err) {
      this.log(`DM reply to ${handle} failed: ${(err as Error).message}`);
    }
  }

  private dmActionsFor(handle: string, dmKey: string, name: string, memberships: { record: GroupRecord; member: Member }[]): DmActions {
    const testMoney = this.deps.testMoney;
    return {
      ...(testMoney ? { addTestMoney: ({ usd }: { usd: number }) => this.addTestMoney(memberships, usd) } : {}),
      sendCardLink: async () => {
        const first = memberships[0];
        return first ? this.sendCardLink(first.member) : "They aren't in any Kitty yet.";
      },
      sendStatusLink: async () => {
        const base = this.deps.invites?.baseUrl;
        if (!base) return "The Kitty page isn't configured, so no link to send.";
        if (!memberships.some((m) => m.member.wallet)) return "They haven't joined any Kitty yet, so there's nothing to show.";
        const url = new URL(base);
        url.searchParams.set("v", "1");
        const link = await this.cardLink(this.withChats(url, handle), "All your kitties", "Limits, what's left, and resets");
        await this.sendDm(handle, dmKey, name, `all your kitties in one place: ${link}`);
        return "Sent them the link to see all their group chats.";
      },
      sendTopUpLink: async () => {
        const linked = memberships.find((m) => m.member.wallet);
        if (!linked) return "They don't have a Kitty account yet, so there's nothing to add money to. Tell them to join in their group first.";
        const base = this.deps.invites?.baseUrl;
        if (!base) return "The add-money page isn't configured, so no link to send.";
        const url = new URL(base);
        url.searchParams.set("a", linked.member.wallet!.address);
        const link = await this.cardLink(this.withChats(url, handle), "Add money to Kitty", "Apple Pay or debit");
        await this.sendDm(handle, dmKey, name, `add money to your Kitty account here: ${link}`);
        return "Sent them the add-money link.";
      },
    };
  }

  private async handleReaction(reaction: IncomingReaction): Promise<void> {
    const emoji = APPROVE_WORDS.has(reaction.emoji.trim().toLowerCase()) ? APPROVAL_EMOJI : reaction.emoji;
    const record = this.groupFor(reaction.chatId);
    const member = this.memberFor(record, reaction.senderHandle);
    const request =
      record.requests.find((r) => r.previewMessageId && sameMessage(r.previewMessageId, reaction.targetMessageId)) ??
      // The chat port couldn't learn the card's real id (it fell back to "local:…"), so a 👍 can't
      // be matched by id. Treat an approving 👍 like the "👍" text: the sender's latest open card.
      (emoji === APPROVAL_EMOJI && reaction.added
        ? [...record.requests]
            .reverse()
            .find(
              (r) =>
                r.previewMessageId?.startsWith("local:") &&
                r.state.name === "awaiting_approval" &&
                r.state.requiredApprovers.includes(member.id),
            )
        : undefined);
    if (!request || request.state.name !== "awaiting_approval") return;
    await this.apply(record, request, { type: "reaction", memberId: member.id, emoji, added: reaction.added, at: this.now() });
    this.deps.store.save();
  }

  /**
   * Completed money events in a chat (settled or failed splits and buys), newest first. Pass a
   * memberId to keep only the ones that person was in (used for the cross-chat DM summary).
   */
  private recentActivity(record: GroupRecord, memberId?: string, limit = 8): string[] {
    const done = record.requests.filter((r) => r.state.name === "done" || r.state.name === "failed");
    const mine = memberId
      ? done.filter((r) => r.split && (r.split.payeeMemberId === memberId || memberId in r.split.shares))
      : done;
    return mine
      .slice(-limit)
      .reverse()
      .map((r) => {
        const total = formatUsdc(r.split?.total ?? usdc(0));
        const payee = r.split ? this.name(record, r.split.payeeMemberId) : "?";
        const verb = r.flow === "pay_before" ? "bought, paid by" : "split, paid back to";
        const debts = (r.state as { debts?: { memberId: string; amount: Usdc }[] }).debts ?? [];
        const status = debts.length
          ? `owed: ${debts.map((d) => `${this.name(record, d.memberId)} ${formatUsdc(d.amount)}`).join(", ")}`
          : r.state.name === "failed"
            ? "didn't go through"
            : "settled";
        return `- #${r.number} ${r.title} ${total} (${verb} ${payee}): ${status}`;
      });
  }

  /**
   * The simplest way for the group to settle its outstanding debts: gather recorded debts (debtor
   * owes that split's payee), use the onchain amount when the adapter can read it (so paid-back
   * debts drop off), then net them to the fewest transfers.
   */
  private async netSettlement(record: GroupRecord): Promise<string> {
    const wallet = this.walletFor(record);
    const pairs = new Map<string, { debtor: Member; creditor: Member; local: bigint }>();
    for (const r of record.requests) {
      if (!r.split) continue;
      const creditor = record.group.members.find((m) => m.id === r.split!.payeeMemberId);
      if (!creditor) continue;
      const debts = (r.state as { debts?: { memberId: string; amount: Usdc }[] }).debts ?? [];
      for (const d of debts) {
        const debtor = record.group.members.find((m) => m.id === d.memberId);
        if (!debtor || debtor.id === creditor.id) continue;
        const key = `${debtor.id}->${creditor.id}`;
        const prev = pairs.get(key);
        pairs.set(key, { debtor, creditor, local: (prev?.local ?? 0n) + d.amount });
      }
    }
    const debts: Transfer[] = [];
    for (const { debtor, creditor, local } of pairs.values()) {
      let amount = local;
      if (wallet.owed) {
        try {
          amount = await wallet.owed(debtor, creditor);
        } catch {
          /* keep the locally recorded amount */
        }
      }
      if (amount > 0n) debts.push({ from: debtor.id, to: creditor.id, amount: amount as Usdc });
    }
    const net = netTransfers(debts);

    // Commit the netting onchain when the contract supports it, so the fewer transfers are real and
    // not just advice. Falls back to advisory (returns false) on an older deployment.
    let executed = false;
    const memberOf = (id: string) => record.group.members.find((m) => m.id === id);
    const resolvable = (t: Transfer) => memberOf(t.from) && memberOf(t.to);
    if (wallet.netSettle && debts.length > net.length && debts.every(resolvable) && net.every(resolvable)) {
      const edges = (ts: Transfer[]) => ts.map((t) => ({ from: memberOf(t.from)!, to: memberOf(t.to)!, amount: t.amount }));
      try {
        executed = await wallet.netSettle(edges(debts), edges(net));
      } catch (err) {
        this.log(`netSettle failed: ${(err as Error).message}`);
      }
    }

    if (net.length === 0) {
      return executed ? "cleared it out, everyone's square now 🎉" : "nobody owes anybody right now, you're all square 🎉";
    }
    const lines = net.map((t) => `${this.name(record, t.from)} → ${this.name(record, t.to)} ${formatUsdc(t.amount)}`);
    const note = debts.length > net.length ? `\n(${net.length} transfer${net.length === 1 ? "" : "s"} instead of ${debts.length})` : "";
    const header = executed ? "netted everyone down, it's just:" : "simplest way to settle up:";
    return `${header}\n${lines.join("\n")}${note}`;
  }

  /**
   * One pass of proactive reminders across every chat: nudge for approval cards that have gone
   * stale and for outstanding debts. Each item is nudged once per process run. Run this via `run()`
   * so it's serialized with normal chat handling. Off unless the server starts the reminder loop.
   */
  async remind(staleMs = 12 * 60 * 60 * 1000): Promise<void> {
    const now = this.now();
    for (const record of this.deps.store.all()) {
      for (const r of record.requests) {
        if (r.state.name !== "awaiting_approval" || now - r.createdAt < staleMs) continue;
        const key = `stale:${record.group.chatId}:${r.id}`;
        if (this.nudged.has(key)) continue;
        this.nudged.add(key);
        const done = new Set(r.state.approvals.filter((a) => a.emoji === APPROVAL_EMOJI).map((a) => a.memberId));
        const waiting = r.state.requiredApprovers.filter((m) => !done.has(m)).map((m) => this.name(record, m));
        if (waiting.length) await this.say(record.group.chatId, `still need a 👍 from ${waiting.join(" and ")} for #${r.number} ${r.title} 👀`);
      }
      for (const r of record.requests) {
        if (!r.split) continue;
        const debts = (r.state as { debts?: { memberId: string; amount: Usdc }[] }).debts ?? [];
        for (const d of debts) {
          const debtor = record.group.members.find((m) => m.id === d.memberId);
          const creditor = record.group.members.find((m) => m.id === r.split!.payeeMemberId);
          if (!debtor || !creditor || debtor.id === creditor.id) continue;
          const key = `debt:${record.group.chatId}:${r.id}:${debtor.id}`;
          if (this.nudged.has(key)) continue;
          this.nudged.add(key);
          await this.say(record.group.chatId, `heads up ${debtor.displayName}, still owe ${creditor.displayName} ${formatUsdc(d.amount)} from ${r.title}`);
        }
      }
    }
  }

  /** A spending summary ("what did we spend?"): total, per-person breakdown, biggest spender. */
  private spendingSummary(record: GroupRecord): string {
    const done = record.requests.filter((r) => r.state.name === "done" && r.split);
    if (done.length === 0) return "no spending in this chat yet";
    let total = 0n;
    const perPerson = new Map<string, bigint>();
    for (const r of done) {
      total += r.split!.total;
      for (const [id, amt] of Object.entries(r.split!.shares)) perPerson.set(id, (perPerson.get(id) ?? 0n) + amt);
    }
    const ranked = [...perPerson].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : 1));
    const byPerson = ranked.map(([id, amt]) => `${this.name(record, id)} ${formatUsdc(amt as Usdc)}`).join(", ");
    const top = ranked[0];
    const topLine = top ? `\nbiggest spender: ${this.name(record, top[0])} (${formatUsdc(top[1] as Usdc)})` : "";
    return `${record.group.name}: ${formatUsdc(total as Usdc)} across ${done.length} thing${done.length === 1 ? "" : "s"}.\nby person: ${byPerson}${topLine}`;
  }

  private async snapshot(record: GroupRecord): Promise<string> {
    const members = await Promise.all(
      record.group.members.map(async (m) => {
        if (!m.wallet) return `- ${m.displayName} (${m.id}): Kitty account not set up yet`;
        const wallet = this.walletFor(record);
        const [status, balance] = await Promise.all([wallet.getLimitStatus(m), wallet.balance?.(m)]);
        const limit = status.limit.amount > 0n ? status.limit : m.limit;
        const when = limit.period === "once" ? "in total (one time, never refills)" : `this ${limit.period === "weekly" ? "week" : "month"}`;
        const money = balance === undefined ? "" : `balance ${formatUsdc(balance)} (money in their account); `;
        const card = this.deps.cards ? (this.deps.store.card(m.id) ? "; card saved for buys" : "; no card saved") : "";
        return `- ${m.displayName} (${m.id}): ${money}this chat can still take ${formatUsdc(status.remaining)} of their ${formatUsdc(limit.amount)} limit ${when}${card}`;
      }),
    );
    const open = record.requests
      .filter((r) => r.state.name === "awaiting_approval")
      .map((r) => {
        const s = r.state.name === "awaiting_approval" ? r.state : undefined;
        const approved = new Set(s?.approvals.filter((a) => a.emoji === APPROVAL_EMOJI).map((a) => a.memberId));
        const waiting = (s?.requiredApprovers ?? []).filter((m) => !approved.has(m)).map((m) => this.name(record, m));
        return `- #${r.number} ${r.title} ${formatUsdc(r.split?.total ?? usdc(0))}, waiting on ${waiting.join(", ") || "nobody"}`;
      });
    const plan = record.plan ? `${formatUsdc(record.plan.amount)} each ${perPeriod(record.plan.period)}` : "not set (ask: a trip with a one-time limit, or weekly/monthly?)";
    const tab = record.requests
      .filter((r) => r.onTab && r.state.name === "settling")
      .map((r) => `- #${r.number} ${r.title} ${formatUsdc(r.split?.total ?? usdc(0))}`);
    const recent = this.recentActivity(record);
    const usuals = Object.values(record.preferences ?? {}).map((p) => `- ${p.item}: ${p.choice}`);
    const personal = Object.entries(record.memberPreferences ?? {}).flatMap(([id, prefs]) =>
      Object.values(prefs).map((p) => `- ${this.name(record, id)}'s ${p.item}: ${p.choice}`),
    );
    const subs = this.subscriptions(record)
      .filter((s) => s.status !== "cancelled")
      .map((s) => {
        const shares = Object.entries(s.split.shares)
          .filter(([id]) => id !== s.split.payeeMemberId)
          .map(([id, a]) => `${this.name(record, id)} ${formatUsdc(a)}`)
          .join(", ");
        const when =
          s.status === "active" && s.nextAt
            ? `next charge ${new Date(s.nextAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, charged ${s.charges} time${s.charges === 1 ? "" : "s"}`
            : "waiting on 👍s to start";
        return `- ${s.title}: ${formatUsdc(s.split.total)} ${s.every}, paid back to ${this.name(record, s.split.payeeMemberId)} by ${shares || "nobody"}; ${when}`;
      });
    return `Plan: ${plan}\n\nSubscriptions (charge automatically each period; "cancel <name>" stops one):\n${subs.join("\n") || "- none"}\n\nMembers:\n${members.join("\n") || "- (none yet)"}\n\nOpen requests:\n${open.join("\n") || "- none"}\n\nOn the tab (settles on "settle up"):\n${tab.join("\n") || "- nothing"}\n\nUsuals (group's saved picks for generic buys; use instead of asking):\n${usuals.join("\n") || "- none set"}\n\nPersonal usuals (the asker gets their own first):\n${personal.join("\n") || "- none set"}\n\nRecent transactions in THIS chat (for history questions):\n${recent.join("\n") || "- none yet"}`;
  }

  // --- what the agent can do --------------------------------------------------

  /** An even split of `totalUsd` among `participants`, or the exact amounts given, paid back to `payer`. */
  private buildSplit(record: GroupRecord, input: { totalUsd: number; payer: string; participants: string[]; amountsUsd?: Record<string, number> }): Split {
    const payer = this.resolve(record, input.payer);
    if (input.amountsUsd) {
      const shares = Object.fromEntries(Object.entries(input.amountsUsd).map(([n, a]) => [this.resolve(record, n).id, usdc(a)]));
      return customSplit({ shares, payeeMemberId: payer.id });
    }
    const participants = input.participants.map((p) => this.resolve(record, p));
    return evenSplit({ total: usdc(input.totalUsd), participantIds: [...new Set(participants.map((p) => p.id))], payeeMemberId: payer.id });
  }

  private actionsFor(record: GroupRecord, sender: Member): TreasuryActions {
    return {
      proposeReimbursement: async (input) => {
        try {
          const split = this.buildSplit(record, input);
          const request = await this.startReimbursement(record, sender, input.title, split, input.settle === "tab");
          return `Posted approval card #${request.number}: ${this.cardText(record, request)}`;
        } catch (err) {
          return `Could not propose that: ${(err as Error).message}`;
        }
      },
      splitByItem: async ({ payer, claims }) => {
        try {
          const receipt = this.lastReceipt.get(record.group.chatId);
          if (!receipt?.lineItems?.length) return "I don't have a receipt with items to split. Post the receipt photo first.";
          const payee = this.resolve(record, payer);
          // Claims come as 1-based item numbers per person name; resolve names and shift to 0-based indices.
          const resolved: Record<string, number[]> = {};
          for (const [name, numbers] of Object.entries(claims)) {
            const member = this.resolve(record, name);
            resolved[member.id] = numbers.map((n) => n - 1).filter((i) => i >= 0 && i < receipt.lineItems!.length);
          }
          const split = byItemSplit({
            lineItems: receipt.lineItems,
            claims: resolved,
            ...(receipt.tax ? { tax: receipt.tax } : {}),
            ...(receipt.tip ? { tip: receipt.tip } : {}),
            payeeMemberId: payee.id,
          });
          const title = receipt.merchant ?? "Dinner";
          const request = await this.startReimbursement(record, sender, title, split, false);
          return `Posted approval card #${request.number}: ${this.cardText(record, request)}`;
        } catch (err) {
          return `Could not split that by item: ${(err as Error).message}`;
        }
      },
      setMyLimit: async ({ usd, period }) => this.setLimit(record, sender, { amount: usdc(usd), period }),
      setGroupPlan: async ({ usd, period, name }) => {
        record.plan = { amount: usdc(usd), period };
        if (name?.trim()) record.group.name = name.trim();
        if (period === "once") record.group.kind = "trip";
        // People who haven't confirmed a limit yet get the plan in their join link.
        for (const m of record.group.members) if (!m.wallet) m.limit = { ...record.plan };
        return `${record.group.name}'s plan is now ${formatUsdc(record.plan.amount)} each ${perPeriod(period)}.`;
      },
      settleUp: async () => this.settleUp(record),
      netDebts: async () => this.netSettlement(record),
      spendingSummary: async () => this.spendingSummary(record),
      callRestaurant: async (input) => {
        try {
          return await this.callRestaurant(record, sender, input);
        } catch (err) {
          return `Could not place the call: ${(err as Error).message}`;
        }
      },
      buyForGroup: async (input) => {
        try {
          return await this.startPurchase(record, sender, input);
        } catch (err) {
          return `Could not start that: ${(err as Error).message}`;
        }
      },
      leave: async () => this.leave(record, sender),
      setPreference: async ({ item, choice, scope }) => {
        const key = normalizePreferenceKey(item);
        if (!key || !choice.trim()) return "Tell me the item and what to get for it.";
        const pref = { item: item.trim(), choice: choice.trim(), setBy: sender.id, at: this.now() };
        if (scope === "personal") {
          record.memberPreferences ??= {};
          (record.memberPreferences[sender.id] ??= {})[key] = pref;
        } else {
          record.preferences ??= {};
          record.preferences[key] = pref;
        }
        this.deps.store.put(record);
        this.deps.store.save();
        const whose = scope === "personal" ? `${sender.displayName}'s` : "the group's";
        return `Saved as ${whose} usual: ${item.trim()} means ${choice.trim()}.`;
      },
      sendJoinLink: async ({ name }) => {
        try {
          return await this.sendJoinLink(record, name ? this.resolve(record, name) : sender);
        } catch (err) {
          return `Could not send the link: ${(err as Error).message}`;
        }
      },
      cancel: async ({ number }) => {
        const request = record.requests.find((r) => r.number === number);
        if (!request || ["done", "cancelled", "rejected", "failed"].includes(request.state.name)) {
          return `There's no open request #${number}.`;
        }
        if (request.split && !(sender.id in request.split.shares)) return "Only people in the split can cancel it.";
        await this.apply(record, request, { type: "cancel", reason: `cancelled by ${sender.displayName}` });
        return `Cancelled #${number}.`;
      },
      startSubscription: async (input) => {
        try {
          return await this.startSubscription(record, sender, input);
        } catch (err) {
          return `Could not set that up: ${(err as Error).message}`;
        }
      },
      cancelSubscription: async ({ title }) => this.cancelSubscription(record, sender, title),
      sendCardLink: async ({ name }) => {
        try {
          return await this.sendCardLink(name ? this.resolve(record, name) : sender, record);
        } catch (err) {
          return `Could not send that: ${(err as Error).message}`;
        }
      },
    };
  }

  // --- balance = what your kitties can take ------------------------------------

  /**
   * Tops each account up so its balance covers what all its kitties can still take this period
   * (the sum of each chat's remaining cap). A pull lowers both sides equally, so this only acts
   * when a cap refills (a new week or month), a cap goes up, or someone joins another kitty.
   * Never takes money out: Kitty can't, and extra money is the member's own.
   */
  async topUpBalances(): Promise<void> {
    const mode = this.deps.autoTopUp;
    if (!mode) return;
    const accounts = new Map<string, { record: GroupRecord; member: Member }[]>();
    for (const record of this.deps.store.all()) {
      for (const member of record.group.members) {
        if (!member.wallet) continue;
        const key = member.wallet.address.toLowerCase();
        accounts.set(key, [...(accounts.get(key) ?? []), { record, member }]);
      }
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    for (const [address, memberships] of accounts) {
      try {
        const need = await this.topUpNeed(memberships);
        if (!need || need.short < CENT) continue;
        const { member, record } = memberships[0]!;
        const short = roundUpToCent(need.short);
        if (mode.mode === "send") {
          const sent = this.autoTopUpSent.get(address);
          const today = sent?.day === day ? sent.amount : usdc(0);
          const room = usdc(mode.dailyUsd) - today;
          const amount = (short < room ? short : room) as Usdc;
          if (amount < CENT) continue;
          await mode.send(member.wallet!.address, amount);
          this.autoTopUpSent.set(address, { day, amount: (today + amount) as Usdc });
          this.log(`auto top-up: ${formatUsdc(amount)} to ${member.wallet!.address}`);
          await this.sendDm(
            member.id,
            `dm:${member.id}`,
            member.displayName,
            `🔄 topped you up ${formatUsdc(amount)}, so your balance (${formatUsdc((need.balance + amount) as Usdc)}) covers what your kitties can take right now (${formatUsdc(need.target)}).`,
          );
        } else {
          const key = `${address}:${day}`;
          if (this.topUpReminded.has(key) || !this.deps.invites) continue;
          this.topUpReminded.add(key);
          const url = new URL(this.deps.invites.baseUrl);
          url.searchParams.set("a", member.wallet!.address);
          url.searchParams.set("c", this.chatLabel(record, member.id));
          await this.sendDm(
            member.id,
            `dm:${member.id}`,
            member.displayName,
            `your kitties can take up to ${formatUsdc(need.target)} right now and you have ${formatUsdc(need.balance)}. add ${formatUsdc(short)} so your shares go through: ${await this.cardLink(this.withChats(url, member.id), `Add ${formatUsdc(short)} to Kitty`, "Apple Pay or debit")}`,
          );
        }
      } catch (err) {
        this.log(`auto top-up for ${address} failed: ${(err as Error).message}`);
      }
    }
  }

  /** What one account's kitties can take this period, its balance, and the gap. Undefined when the balance can't be read. */
  private async topUpNeed(memberships: { record: GroupRecord; member: Member }[]): Promise<{ target: Usdc; balance: Usdc; short: Usdc } | undefined> {
    let target = 0n;
    for (const { record, member } of memberships) {
      target += (await this.walletFor(record).getLimitStatus(member)).remaining;
    }
    const first = memberships[0]!;
    const balance = await this.walletFor(first.record).balance?.(first.member);
    if (balance === undefined) return undefined;
    return { target: target as Usdc, balance, short: (target > balance ? target - balance : 0n) as Usdc };
  }

  // --- subscriptions (Spotify, rent, a cleaner) ---------------------------------

  /** Posts the setup card. Everyone 👍s once; that settle is the first charge, then it repeats. */
  private async startSubscription(
    record: GroupRecord,
    sender: Member,
    input: { title: string; totalUsd: number; payer: string; participants: string[]; every: "weekly" | "monthly"; amountsUsd?: Record<string, number> },
  ): Promise<string> {
    const title = input.title.trim();
    const live = this.subscriptions(record).find((s) => s.status !== "cancelled" && s.title.toLowerCase() === title.toLowerCase());
    if (live) return `${live.title} is already ${live.status === "active" ? "running" : "waiting on 👍s"}. Cancel it first to change it.`;
    const split = this.buildSplit(record, input);
    const subs = (record.subscriptions ??= []);
    const sub: Subscription = {
      id: `${record.group.id}:sub:${subs.length + 1}`,
      title,
      every: input.every,
      split,
      status: "pending",
      setupRequestId: "",
      createdBy: sender.id,
      createdAt: this.now(),
      charges: 0,
    };
    subs.push(sub);
    const request = await this.startReimbursement(record, sender, title, split, false, sub.id);
    sub.setupRequestId = request.id;
    this.deps.store.save();
    const setup = await this.setUpFor(record, sub);
    return `Posted subscription card #${request.number}: ${this.cardText(record, request)}${setup ? `\n${setup}` : ""}`;
  }

  /**
   * Everyone in a new subscription gets set up for it privately: a Face ID link for anyone without
   * a Kitty account, a save-card link for anyone without a card, and an add-money link for anyone
   * whose balance can't cover their first share. Returns a line for the agent ("" when all set).
   */
  private async setUpFor(record: GroupRecord, sub: Subscription): Promise<string> {
    const joining: string[] = [];
    const cards: string[] = [];
    const short: string[] = [];
    const notes = new Set<string>();
    for (const [memberId, share] of Object.entries(sub.split.shares)) {
      const member = record.group.members.find((m) => m.id === memberId);
      if (!member) continue;
      try {
        if (!member.wallet) {
          const sent = await this.sendJoinLink(record, member);
          if (sent.startsWith("No link sent")) notes.add(sent);
          else joining.push(member.displayName);
          continue;
        }
        if (this.deps.cards && !this.deps.store.card(member.id)) {
          await this.sendCardLink(member, record);
          cards.push(member.displayName);
        }
        if (memberId === sub.split.payeeMemberId || !this.deps.invites) continue;
        const balance = await this.walletFor(record).balance?.(member);
        if (balance === undefined || balance >= share) continue;
        const url = new URL(this.deps.invites.baseUrl);
        url.searchParams.set("a", member.wallet.address);
        url.searchParams.set("c", this.chatLabel(record, member.id));
        await this.dm(
          record,
          member,
          `your ${sub.title} share is ${formatUsdc(share)} a ${sub.every === "weekly" ? "week" : "month"} and you have ${formatUsdc(balance)}. add money so it goes through: ${await this.cardLink(this.withChats(url, member.id), `Add money for ${sub.title}`, "Apple Pay or debit")}`,
        );
        short.push(member.displayName);
      } catch (err) {
        this.log(`setup for ${sub.title}, ${member.displayName}: ${(err as Error).message}`);
      }
    }
    return [
      joining.length ? `Texted a Face ID setup link to ${joining.join(", ")} (they need a Kitty account before it can start).` : "",
      cards.length ? `Texted a save-card link to ${cards.join(", ")}.` : "",
      short.length ? `Texted an add-money link to ${short.join(", ")} (balance below their share).` : "",
      ...notes,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async cancelSubscription(record: GroupRecord, sender: Member, title: string): Promise<string> {
    const wanted = title.trim().toLowerCase();
    const live = this.subscriptions(record).filter((s) => s.status !== "cancelled");
    const sub = live.find((s) => s.title.toLowerCase() === wanted) ?? live.find((s) => s.title.toLowerCase().includes(wanted) || wanted.includes(s.title.toLowerCase()));
    if (!sub) return live.length ? `No subscription called "${title}". Running: ${live.map((s) => s.title).join(", ")}.` : "This chat has no subscriptions.";
    if (!(sender.id in sub.split.shares)) return `Only people in ${sub.title} can cancel it.`;
    if (sub.status === "pending") {
      const setup = record.requests.find((r) => r.id === sub.setupRequestId);
      if (setup?.state.name === "awaiting_approval") await this.apply(record, setup, { type: "cancel", reason: `cancelled by ${sender.displayName}` });
    }
    sub.status = "cancelled";
    sub.cancelledBy = sender.id;
    delete sub.nextAt;
    this.deps.store.save();
    return `Stopped ${sub.title}. No more charges.`;
  }

  /** This chat's subscriptions, with any whose setup card was cancelled or expired marked cancelled. */
  private subscriptions(record: GroupRecord): Subscription[] {
    for (const sub of record.subscriptions ?? []) {
      if (sub.status !== "pending") continue;
      const setup = record.requests.find((r) => r.id === sub.setupRequestId);
      if (setup && ["cancelled", "rejected", "failed"].includes(setup.state.name)) sub.status = "cancelled";
    }
    return record.subscriptions ?? [];
  }

  /**
   * Charges every subscription that's due. Run on a timer (index.ts). The group approved it when
   * it started, so the relayed 👍s go in at once; the contract still caps each share, and a share
   * it can't pull becomes a debt like any split. A bot that was off for a while charges once, not
   * once per missed period, so nobody wakes up to a pile of charges.
   */
  async chargeSubscriptions(): Promise<void> {
    const now = this.now();
    for (const record of this.deps.store.all()) {
      for (const sub of this.subscriptions(record)) {
        if (sub.status !== "active" || sub.nextAt === undefined || sub.nextAt > now) continue;
        const due = sub.nextAt;
        // Move the due date first and save, so a crash mid-charge can't charge twice.
        while (sub.nextAt <= now) sub.nextAt = nextCharge(sub.nextAt, sub.every, this.deps.subscriptionEveryMs);
        this.deps.store.save();
        const creator = record.group.members.find((m) => m.id === sub.createdBy) ?? this.memberFor(record, sub.createdBy);
        const label = new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const request = await this.startReimbursement(record, creator, `${sub.title} · ${label}`, sub.split, false, sub.id, true);
        if (request.state.name === "awaiting_approval") {
          for (const memberId of request.state.requiredApprovers) {
            await this.apply(record, request, { type: "reaction", memberId, emoji: APPROVAL_EMOJI, added: true, at: now });
          }
        }
        this.deps.store.save();
      }
    }
  }

  /** Pay-after: participants are in, the receipt is read, now everyone 👍s the real split. */
  private async startReimbursement(record: GroupRecord, sender: Member, title: string, split: Split, onTab = false, subscriptionId?: string, charge = false): Promise<RequestRecord> {
    const number = record.requests.reduce((max, r) => Math.max(max, r.number), 0) + 1;
    const request: RequestRecord = {
      id: `${record.group.id}#${number}`,
      number,
      title,
      flow: "pay_after",
      requesterId: sender.id,
      state: initialState("pay_after"),
      split,
      createdAt: this.now(),
      ...(onTab ? { onTab: true } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(charge ? { charge: true } : {}),
    };
    record.requests.push(request);

    // A subscription has no receipt photo; don't borrow whatever receipt was posted last.
    const posted = subscriptionId ? undefined : this.lastReceipt.get(record.group.chatId);
    const receipt: Receipt =
      posted && posted.total === split.total ? posted : { source: "photo", total: split.total, at: this.now() };

    this.starting.add(request.id);
    try {
      for (const memberId of Object.keys(split.shares)) {
        await this.apply(record, request, { type: "participant_in", memberId });
      }
      await this.apply(record, request, { type: "participants_locked" });
    } finally {
      this.starting.delete(request.id);
    }
    await this.apply(record, request, {
      type: "receipt_read",
      receipt,
      split,
      screenshot: { image: receipt.image ?? { uri: "" }, caption: title },
      tolerance: usdc(0),
      deadline: this.now() + APPROVAL_WINDOW_MS,
    });
    // The payer is owed the money, so posting the receipt counts as their approval.
    await this.apply(record, request, { type: "reaction", memberId: split.payeeMemberId, emoji: APPROVAL_EMOJI, added: true, at: this.now() });
    return request;
  }

  // --- Kitty calls a restaurant (ElevenLabs) -----------------------------------

  private async callRestaurant(
    record: GroupRecord,
    sender: Member,
    input: Parameters<TreasuryActions["callRestaurant"]>[0],
  ): Promise<string> {
    const calls = this.deps.calls;
    if (!calls) return "Phone calls aren't set up on this bot (needs ElevenLabs keys).";
    const phone = toE164(input.phone);
    if (!phone) return `"${input.phone}" doesn't look like a phone number. Ask for the restaurant's number.`;
    const request = {
      restaurant: input.restaurant,
      phone,
      partySize: input.partySize,
      when: input.when,
      reservationName: input.reservationName ?? sender.displayName,
      ...(input.notes ? { notes: input.notes } : {}),
      group: record.group.name,
    };
    const { callId, link } = await calls.start(request);
    this.log(`calling ${input.restaurant} (${phone}) for ${record.group.chatId}: ${callId}`);
    if (link) {
      // No phone line: the restaurant gets a text with a link that starts the same voice call in the browser.
      await this.deps.chat.sendDirectMessage(
        phone,
        `📞 Hi! This is Kitty, an AI assistant for a group called ${request.group}. I'd like to book a table at ${request.restaurant} for ${request.partySize}, ${request.when}. Tap to talk to me: ${link}`,
      );
      this.inBackground(() => this.followCall(record, request, callId));
      return `No phone line on this bot, so Kitty texted ${input.restaurant} at ${phone} a link to talk to the voice agent. Tell the group Kitty is reaching out to ${input.restaurant} now; the result will be posted when the call ends.`;
    }
    this.inBackground(() => this.followCall(record, request, callId));
    return `Calling ${input.restaurant} now for ${input.partySize} ${input.when}. The result will be posted when the call ends.`;
  }

  /** Waits for the call to finish (up to 15 minutes), then tells the group how it went. */
  private async followCall(record: GroupRecord, request: { restaurant: string; partySize: number; when: string; reservationName: string }, callId: string): Promise<void> {
    const calls = this.deps.calls!;
    const every = this.deps.callPollMs ?? 5_000;
    const deadline = this.now() + 15 * 60_000;
    let result = await calls.result(callId);
    while (result.status === "in_progress" && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, every));
      try {
        result = await calls.result(callId);
      } catch (err) {
        this.log(`call ${callId}: ${(err as Error).message}`);
      }
    }
    const who = `${request.restaurant}`;
    let text: string;
    if (result.status === "in_progress") text = `📞 still no word back from the ${who} call, I'll stop waiting. might be worth calling them yourselves`;
    else if (result.pickedUp && result.pickedUp !== "answered") {
      const why = result.pickedUp === "voicemail" ? "it went to voicemail" : result.pickedUp === "busy" ? "the line was busy" : "nobody picked up";
      text = `📞 called ${who} but ${why}. want me to try again later?`;
    } else if (result.status === "failed") text = `📞 the call to ${who} didn't go through (${result.error ?? "unknown error"})`;
    else if (result.booked) {
      text = `📞 booked ${who} for ${request.partySize}, ${result.confirmedTime ?? request.when}, under ${request.reservationName} ✅`;
    } else if (result.alternative) {
      text = `📞 ${who} can't do ${request.when}. they offered ${result.alternative}. want it? I can call back`;
    } else {
      text = `📞 called ${who}, no booking. ${result.summary ?? ""}`.trim();
    }
    await this.run(() => this.say(record.group.chatId, text).then(() => undefined));
  }

  // --- Kitty buys it (pay before) ---------------------------------------------

  private async startPurchase(
    record: GroupRecord,
    sender: Member,
    input: Parameters<TreasuryActions["buyForGroup"]>[0],
  ): Promise<string> {
    if (!this.deps.purchase) return "Buying isn't set up on this bot yet.";
    const payer = this.resolve(record, input.payer);
    if (!payer.wallet) return `${payer.displayName} needs a Kitty account first (send_join_link), so they can be paid back.`;
    const saved = this.deps.store.card(payer.id);
    const card = saved && this.deps.cards?.purchaseFor ? { userId: saved.userId, paymentMethodId: saved.paymentMethodId } : undefined;
    const participants = [...new Set(input.participants.map((p) => this.resolve(record, p).id))];
    const number = record.requests.reduce((max, r) => Math.max(max, r.number), 0) + 1;
    const request: RequestRecord = {
      id: `${record.group.id}#${number}`,
      number,
      title: input.title,
      flow: "pay_before",
      requesterId: sender.id,
      state: initialState("pay_before"),
      createdAt: this.now(),
      buy: { participants, payer: payer.id, ...(card ? { card } : {}) },
    };
    record.requests.push(request);
    this.deps.store.save();
    const purchase = this.purchaseFor(request)!;

    this.inBackground(async () => {
      try {
        const cart = await purchase.buildCart({
          requestText: input.request,
          ...(input.items ? { items: input.items } : {}),
          checkout: { kind: "store_account", memberId: payer.id, store: purchase.store },
        });
        await this.run(async () => {
          await this.apply(record, request, { type: "cart_built", cart });
          this.deps.store.save();
        });
      } catch (err) {
        await this.run(() => this.purchaseFailed(record, request, `couldn't build the cart: ${(err as Error).message}`));
      }
    });
    const onCard = card ? ` It goes on ${payer.displayName}'s own card${saved?.label ? ` (${saved.label})` : ""}.` : "";
    return `Shopping for #${number} ${input.title} at ${purchase.store} now. The checkout will come back for 👍s; nothing is ordered until everyone approves.${onCard}`;
  }

  /** The store adapter for a buy: the payer's own saved card when they have one, else the bot's default. */
  private purchaseFor(request: RequestRecord): PurchaseAdapter | undefined {
    const card = request.buy?.card;
    const make = this.deps.cards?.purchaseFor;
    if (!card || !make) return this.deps.purchase;
    let adapter = this.purchases.get(request.id);
    if (!adapter) this.purchases.set(request.id, (adapter = make(card)));
    return adapter;
  }

  /** The cart is priced: split it, flag anyone whose limit is short, and post the checkout for 👍s. */
  private async previewCart(record: GroupRecord, request: RequestRecord, built: Cart): Promise<void> {
    const purchase = this.purchaseFor(request);
    if (!purchase || !request.buy) return this.purchaseFailed(record, request, "buying isn't set up");
    const { screenshot, total, cart } = await purchase.preview(built);
    const split = evenSplit({ total, participantIds: request.buy.participants, payeeMemberId: request.buy.payer });
    await this.apply(record, request, {
      type: "preview_ready",
      split,
      screenshot,
      requiredApprovers: request.buy.participants,
      deadline: this.now() + APPROVAL_WINDOW_MS,
      cart,
    });
    // Everyone in the split must 👍 the checkout before the order is placed, the payer included:
    // real money leaves their card, so they approve it too (no auto-approval here).
    const short: string[] = [];
    for (const [memberId, amount] of Object.entries(split.shares)) {
      if (memberId === split.payeeMemberId) continue;
      const member = record.group.members.find((m) => m.id === memberId);
      if (!member?.wallet) short.push(`${this.name(record, memberId)} isn't set up in Kitty yet`);
      else {
        const { ok, remaining } = await this.walletFor(record).canPull(member, amount);
        if (!ok) short.push(`${member.displayName} only has ${formatUsdc(remaining)} of limit left`);
      }
    }
    if (short.length) await this.say(record.group.chatId, `heads up before you 👍: ${short.join("; ")}. Their share would be owed instead.`);
  }

  private async placeOrder(record: GroupRecord, request: RequestRecord, cart: Cart): Promise<void> {
    const purchase = this.purchaseFor(request);
    if (!purchase) return this.run(() => this.purchaseFailed(record, request, "buying isn't set up"));
    try {
      const receipt = await purchase.placeOrder({ cart });
      await this.run(async () => {
        await this.apply(record, request, { type: "order_placed", receipt });
        this.deps.store.save();
      });
    } catch (err) {
      await this.run(() => this.purchaseFailed(record, request, `the order didn't go through: ${(err as Error).message}`));
    }
  }

  private async purchaseFailed(record: GroupRecord, request: RequestRecord, reason: string): Promise<void> {
    await this.apply(record, request, { type: "fail", reason });
    this.deps.store.save();
    await this.say(record.group.chatId, `❌ #${request.number} ${request.title}: ${reason}. Nothing was charged.`);
  }

  // --- state machine ----------------------------------------------------------

  private async apply(record: GroupRecord, request: RequestRecord, event: RequestEvent): Promise<void> {
    const result = transition(request.state, event);
    if (result.error) {
      this.log(`#${request.number}: ${result.error}`);
      return;
    }
    request.state = result.state;
    for (const effect of result.effects) await this.perform(record, request, effect);
  }

  private async perform(record: GroupRecord, request: RequestRecord, effect: Effect): Promise<void> {
    const chatId = record.group.chatId;
    switch (effect.type) {
      case "post_preview": {
        request.split = effect.split;
        // A scheduled charge was approved when the subscription started: the settle message is the notice.
        if (request.charge) return;
        const card = this.cardText(record, request);
        // Pay-before: post the checkout screenshot WITH the approve text as its caption, so there's
        // one card people see and 👍 (not a separate text message the reactions would miss).
        if (request.flow === "pay_before" && effect.screenshot.image.uri) {
          try {
            this.remember(chatId, `Treasury: ${card}`);
            const ref = await this.deps.chat.postImage(chatId, await asPng(effect.screenshot.image), card);
            request.previewMessageId = ref.id;
            return;
          } catch (err) {
            this.log(`#${request.number}: checkout image not posted (${(err as Error).message}), using a text card`);
          }
        }
        request.previewMessageId = await this.say(chatId, card);
        return;
      }
      case "preview_cart":
        await this.previewCart(record, request, effect.cart);
        return;
      case "place_order":
        await this.say(chatId, `🛒 everyone's in, placing the order for #${request.number} ${request.title}…`);
        this.inBackground(() => this.placeOrder(record, request, effect.cart));
        return;
      case "pull_shares":
        if (request.onTab) {
          await this.say(chatId, `📝 #${request.number} ${request.title} is on the tab. Say "settle up" when you're ready.`);
          return;
        }
        {
          const sub = request.subscriptionId ? record.subscriptions?.find((s) => s.id === request.subscriptionId) : undefined;
          if (sub?.status === "pending" && sub.setupRequestId === request.id) {
            sub.status = "active";
            sub.nextAt = nextCharge(this.now(), sub.every, this.deps.subscriptionEveryMs);
            const next = new Date(sub.nextAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
            await this.say(chatId, `🔁 ${sub.title} is on. First one's now, next on ${next}, then every ${sub.every === "weekly" ? "week" : "month"}. Say "cancel ${sub.title}" to stop it.`);
          }
          await this.pullShares(record, request, effect.split);
          if (sub) sub.charges += 1;
        }
        return;
      case "notify":
        // The settlement summary is posted by pullShares with names; other notices go as-is.
        if (this.starting.has(request.id)) return;
        if (request.state.name !== "done") await this.say(chatId, effect.text);
        return;
      default:
        this.log(`#${request.number}: effect ${effect.type} isn't wired yet`);
    }
  }

  private async pullShares(record: GroupRecord, request: RequestRecord, split: Split): Promise<void> {
    const payee = record.group.members.find((m) => m.id === split.payeeMemberId);
    const to = payee?.wallet
      ? { kind: "wallet" as const, address: payee.wallet.address }
      : { kind: "card" as const, reference: split.payeeMemberId };
    const lines: string[] = [];
    let failed = 0;
    const short: { member: Member; amount: Usdc; reason: string }[] = [];

    for (const [memberId, amount] of Object.entries(split.shares)) {
      if (memberId === split.payeeMemberId || amount === 0n) continue;
      const from = record.group.members.find((m) => m.id === memberId);
      const outcome = from
        ? await this.walletFor(record).pull({ from, to, amount, memo: `${request.title}: your share`, idempotencyKey: `${request.id}:${memberId}` })
        : { status: "failed" as const, reason: "not a member" };
      await this.apply(record, request, {
        type: "share_pulled",
        result: { memberId, amount, status: outcome.status, ...(outcome.txRef ? { txRef: outcome.txRef } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) },
      });
      const who = `${this.name(record, memberId)} → ${this.name(record, split.payeeMemberId)} ${formatUsdc(amount)}`;
      if (outcome.status === "pulled") lines.push(`${who} ✓`);
      else {
        failed++;
        const reason = plainReason(outcome.reason);
        // These failures happen before anything is attempted onchain, so no debt is recorded.
        const attempted = !/linked a wallet|hasn't joined|Arc error|not a member/.test(outcome.reason ?? "");
        lines.push(attempted ? `${who} ✗ ${reason} (still owed)` : `${who} ✗ ${reason}, nothing moved`);
        // Onchain failures become debts the member can pay back later from the Face ID page.
        if (from && outcome.txRef && payee?.wallet) short.push({ member: from, amount, reason });
      }
    }
    await this.apply(record, request, { type: "settle_complete", at: this.now() });
    // A cheery lead-in only when everything cleared; a partial settle stays plain so the ⚠️ reads as real.
    const lead = request.charge
      ? `🔁 ${record.subscriptions?.find((s) => s.id === request.subscriptionId)?.every === "weekly" ? "weekly" : "monthly"} charge\n`
      : failed === 0
        ? `${pick(["all squared up 🎉", "money moved 💸", "settled up"])}\n`
        : "";
    const head = failed === 0 ? `✅ Settled #${request.number} ${request.title}` : `⚠️ Partly settled #${request.number} ${request.title}`;
    await this.say(record.group.chatId, `${lead}${head} (${formatUsdc(split.total)})\n${lines.join("\n")}`);
    for (const { member, amount, reason } of short) {
      if (!payee?.wallet || !this.deps.invites) continue;
      const link = this.pageLink(record, member, {
        r: payee.wallet.address,
        o: payee.displayName,
        m: formatUsdc(amount).slice(1),
      });
      await this.dm(
        record,
        member,
        `heads up: your ${formatUsdc(amount)} share of ${request.title} didn't go through (${reason.replace("their", "your")}), so it's owed to ${payee.displayName} for now. add money and pay it back: ${await this.cardLink(link, `Pay ${payee.displayName} back ${formatUsdc(amount)}`)}`,
      );
    }
  }

  cardText(record: GroupRecord, request: RequestRecord): string {
    const split = request.split;
    if (!split) return `#${request.number} ${request.title}`;
    const shares = Object.entries(split.shares)
      .filter(([id]) => id !== split.payeeMemberId)
      .map(([id, amount]) => `${this.name(record, id)} ${formatUsdc(amount)}`);
    const store = request.flow === "pay_before" && request.state.name === "awaiting_approval" ? request.state.cart?.store : undefined;
    if (store) {
      return [
        `🛒 #${request.number} ${request.title}: ${formatUsdc(split.total)} at ${store}`,
        `${this.name(record, split.payeeMemberId)}'s card pays, paid back by: ${shares.join(", ") || "nobody"}`,
        `👍 this message to approve. I only order once everyone in the split approves.`,
      ].join("\n");
    }
    const sub = request.subscriptionId ? record.subscriptions?.find((s) => s.id === request.subscriptionId) : undefined;
    if (sub && !request.charge) {
      const per = sub.every === "weekly" ? "week" : "month";
      return [
        `🔁 #${request.number} ${request.title}: ${formatUsdc(split.total)} a ${per}`,
        `Pay back ${this.name(record, split.payeeMemberId)}: ${shares.join(", ")}`,
        `👍 to start it. After that Kitty charges it every ${per}, no more 👍s, never past anyone's cap. "cancel ${request.title}" stops it.`,
      ].join("\n");
    }
    return [
      `🧾 #${request.number} ${request.title}: ${formatUsdc(split.total)}`,
      `Pay back ${this.name(record, split.payeeMemberId)}: ${shares.join(", ")}`,
      request.onTab ? `👍 to approve. It goes on the tab and settles on "settle up".` : `👍 this message to approve your share.`,
    ].join("\n");
  }
}
