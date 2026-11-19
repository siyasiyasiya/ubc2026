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
  type WalletAdapter,
} from "@gta/core";
import type { runTurn as RunTurn, TreasuryActions } from "@gta/agent";
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
  /** Kitty account (wallet) address by handle. Filled by the Face ID join watcher; config for now. */
  wallets?: Record<string, string>;
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

export class GroupRuntime {
  private readonly history = new Map<string, string[]>();
  /** The last receipt each group posted, attached to the next proposal that matches its total. */
  private readonly lastReceipt = new Map<string, Receipt>();
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
        limit: { ...this.deps.defaultLimit },
      };
      record.group.members.push(member);
    }
    const address = this.deps.wallets?.[handle];
    if (address && member.wallet?.address !== address) member.wallet = { address };
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

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const record = this.groupFor(msg.chatId);
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
    const request = record.requests.find(
      (r) => r.previewMessageId && sameMessage(r.previewMessageId, reaction.targetMessageId),
    );
    if (!request || request.state.name !== "awaiting_approval") return;
    const member = this.memberFor(record, reaction.senderHandle);
    await this.apply(record, request, { type: "reaction", memberId: member.id, emoji, added: reaction.added, at: this.now() });
    this.deps.store.save();
  }

  private async snapshot(record: GroupRecord): Promise<string> {
    const members = await Promise.all(
      record.group.members.map(async (m) => {
        const status = await this.walletFor(record).getLimitStatus(m);
        return `- ${m.displayName} (${m.id}): ${m.limit.period} limit ${formatUsdc(m.limit.amount)}, ${formatUsdc(status.remaining)} left`;
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
    return `Members:\n${members.join("\n") || "- (none yet)"}\n\nOpen requests:\n${open.join("\n") || "- none"}`;
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
          const request = await this.startReimbursement(record, sender, input.title, split);
          return `Posted approval card #${request.number}: ${this.cardText(record, request)}`;
        } catch (err) {
          return `Could not propose that: ${(err as Error).message}`;
        }
      },
      setMyLimit: async ({ usd, period }) => {
        sender.limit = { amount: usdc(usd), period };
        return `${sender.displayName}'s ${period} limit is now ${formatUsdc(sender.limit.amount)}.`;
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
  private async startReimbursement(record: GroupRecord, sender: Member, title: string, split: Split): Promise<RequestRecord> {
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
        lines.push(`${who} ✗ ${outcome.reason ?? "failed"} (still owed)`);
      }
    }
    await this.apply(record, request, { type: "settle_complete", at: this.now() });
    const head = failed === 0 ? `✅ Settled #${request.number} ${request.title}` : `⚠️ Partly settled #${request.number} ${request.title}`;
    await this.say(record.group.chatId, `${head} (${formatUsdc(split.total)})\n${lines.join("\n")}`);
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
      `👍 this message to approve your share.`,
    ].join("\n");
  }
}
