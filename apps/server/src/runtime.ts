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
  customSplit,
  evenSplit,
  formatUsdc,
  initialState,
  transition,
  usdc,
  type ChatPort,
  type Effect,
  type Group,
  type IncomingMessage,
  type IncomingReaction,
  type Member,
  type Receipt,
  type ReceiptReader,
  type RequestEvent,
  type SpendingLimit,
  type Split,
  type Usdc,
  type WalletAdapter,
} from "@gta/core";
import type { runTurn as RunTurn, TreasuryActions } from "@gta/agent";
import { groupIdForChat, inviteLink, inviteTicket, type DebtPaidEvent, type JoinEvent, type LimitSetEvent } from "@gta/wallet";
import type { GroupRecord, RequestRecord, Store } from "./store.js";

export interface RuntimeDeps {
  chat: ChatPort;
  /** One adapter for every chat, or one per chat (the Arc adapter: limits are per chat onchain). */
  wallet: WalletAdapter | ((chatId: string) => WalletAdapter);
  receipts: ReceiptReader;
  runTurn: typeof RunTurn;
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
  now?: () => number;
  log?: (line: string) => void;
}

const HISTORY_LINES = 30;
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPROVE_WORDS = new Set([APPROVAL_EMOJI, "like", "liked", "thumbsup", "+1"]);

/** "p:0/GUID" and "GUID" refer to the same message; compare on the bare id. */
function sameMessage(a: string, b: string): boolean {
  const bare = (id: string) => id.replace(/^p:\d+\//, "").split(":")[0] ?? id;
  return bare(a) === bare(b);
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
  /** The last receipt each group posted, attached to the next proposal that matches its total. */
  private readonly lastReceipt = new Map<string, Receipt>();
  /** Chats whose roster we've already pulled from the chat port, so we seed members once per chat. */
  private readonly seededRosters = new Set<string>();
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
  }

  /** Handles events one at a time so two messages can't race on the same state. Resolves when done. */
  serial(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.log(`error: ${(err as Error).stack ?? err}`));
    return this.queue;
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
      chatName: record.group.name,
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
    const link = this.inviteLinkFor(record.group.chatId, member.id);
    const where = await this.dm(record, member, `you're invited to ${record.group.name}'s kitty 🎉 one Face ID tap and you're set up: ${link}`);
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
      `tap to confirm your new ${record.group.name} limit, ${formatUsdc(limit.amount)} ${perPeriod(limit.period)}, with Face ID: ${this.pageLink(record, member, { l: formatUsdc(limit.amount).replace("$", ""), p: limit.period })}`,
    );
    return `Raising needs ${member.displayName}'s Face ID, so I ${where === "dm" ? "texted them" : "posted"} a link to confirm.`;
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
    url.searchParams.set("c", record.group.name);
    url.searchParams.set("n", member.displayName);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return url.toString();
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
    return ref.id;
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
      const handles = await this.deps.chat.getParticipants(chatId);
      for (const handle of handles) this.memberFor(record, handle);
      if (handles.length) {
        this.deps.store.save();
        this.log(`seeded ${handles.length} member(s) from the roster of ${chatId}`);
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

    let event = msg.text ? `${member.displayName}: ${msg.text}` : "";
    const image = msg.attachments[0];
    if (image) {
      try {
        const receipt = await this.deps.receipts.read(image);
        this.lastReceipt.set(msg.chatId, receipt);
        const items = (receipt.lineItems ?? []).map((i) => `${i.name} ${formatUsdc(i.amount)}`).join("; ");
        event =
          `[${member.displayName} posted a receipt from ${receipt.merchant ?? "unknown"}: ` +
          `subtotal ${formatUsdc(receipt.subtotal ?? usdc(0))}, tax ${formatUsdc(receipt.tax ?? usdc(0))}, ` +
          `tip ${formatUsdc(receipt.tip ?? usdc(0))}, total ${formatUsdc(receipt.total)}. Items: ${items || "not listed"}]`;
      } catch (err) {
        this.log(`receipt not read: ${(err as Error).message}`);
        event = `[${member.displayName} posted a photo that isn't a receipt]`;
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
    if (reply) await this.say(msg.chatId, reply);
    this.deps.store.save();
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

  private async snapshot(record: GroupRecord): Promise<string> {
    const members = await Promise.all(
      record.group.members.map(async (m) => {
        const status = await this.walletFor(record).getLimitStatus(m);
        if (!m.wallet) return `- ${m.displayName} (${m.id}): Kitty account not set up yet`;
        const limit = status.limit.amount > 0n ? status.limit : m.limit;
        const when = limit.period === "once" ? "in total (one time, never refills)" : `this ${limit.period === "weekly" ? "week" : "month"}`;
        return `- ${m.displayName} (${m.id}): ${formatUsdc(status.remaining)} of ${formatUsdc(limit.amount)} left ${when}`;
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
    return `Plan: ${plan}\n\nMembers:\n${members.join("\n") || "- (none yet)"}\n\nOpen requests:\n${open.join("\n") || "- none"}\n\nOn the tab (settles on "settle up"):\n${tab.join("\n") || "- nothing"}`;
  }

  // --- what the agent can do --------------------------------------------------

  private actionsFor(record: GroupRecord, sender: Member): TreasuryActions {
    return {
      proposeReimbursement: async (input) => {
        try {
          const payer = this.resolve(record, input.payer);
          const participants = input.participants.map((p) => this.resolve(record, p));
          let split: Split;
          if (input.amountsUsd) {
            const shares = Object.fromEntries(
              Object.entries(input.amountsUsd).map(([n, a]) => [this.resolve(record, n).id, usdc(a)]),
            );
            split = customSplit({ shares, payeeMemberId: payer.id });
          } else {
            split = evenSplit({
              total: usdc(input.totalUsd),
              participantIds: [...new Set(participants.map((p) => p.id))],
              payeeMemberId: payer.id,
            });
          }
          const request = await this.startReimbursement(record, sender, input.title, split, input.settle === "tab");
          return `Posted approval card #${request.number}: ${this.cardText(record, request)}`;
        } catch (err) {
          return `Could not propose that: ${(err as Error).message}`;
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
      leave: async () => this.leave(record, sender),
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
    };
  }

  /** Pay-after: participants are in, the receipt is read, now everyone 👍s the real split. */
  private async startReimbursement(record: GroupRecord, sender: Member, title: string, split: Split, onTab = false): Promise<RequestRecord> {
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
    };
    record.requests.push(request);

    const posted = this.lastReceipt.get(record.group.chatId);
    const receipt: Receipt =
      posted && posted.total === split.total ? posted : { source: "photo", total: split.total, at: this.now() };

    for (const memberId of Object.keys(split.shares)) {
      await this.apply(record, request, { type: "participant_in", memberId });
    }
    await this.apply(record, request, { type: "participants_locked" });
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
      case "post_preview":
        request.split = effect.split;
        request.previewMessageId = await this.say(chatId, this.cardText(record, request));
        return;
      case "pull_shares":
        if (request.onTab) {
          await this.say(chatId, `📝 #${request.number} ${request.title} is on the tab. Say "settle up" when you're ready.`);
          return;
        }
        await this.pullShares(record, request, effect.split);
        return;
      case "notify":
        // The settlement summary is posted by pullShares with names; other notices go as-is.
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
    const lead = failed === 0 ? `${pick(["all squared up 🎉", "money moved 💸", "settled up"])}\n` : "";
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
        `heads up: your ${formatUsdc(amount)} share of ${request.title} didn't go through (${reason}), so it's owed to ${payee.displayName} for now. add money and pay it back with Face ID: ${link}`,
      );
    }
  }

  cardText(record: GroupRecord, request: RequestRecord): string {
    const split = request.split;
    if (!split) return `#${request.number} ${request.title}`;
    const shares = Object.entries(split.shares)
      .filter(([id]) => id !== split.payeeMemberId)
      .map(([id, amount]) => `${this.name(record, id)} ${formatUsdc(amount)}`);
    return [
      `🧾 #${request.number} ${request.title}: ${formatUsdc(split.total)}`,
      `Pay back ${this.name(record, split.payeeMemberId)}: ${shares.join(", ")}`,
      request.onTab ? `👍 to approve. It goes on the tab and settles on "settle up".` : `👍 this message to approve your share.`,
    ].join("\n");
  }
}
