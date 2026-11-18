import { cardText, runTurn, type ChatLine } from "../agent/brain.js";
import { readReceipt } from "../agent/receipt.js";
import { formatUsd } from "../core/money.js";
import { memberName, type Store } from "../core/store.js";
import {
  describeTransfers,
  isFullyApproved,
  requiredApprovers,
  type Treasury,
} from "../core/treasury.js";
import type { GroupState, Handle, Proposal } from "../core/types.js";

/** Sends a message to a chat and returns its id (if the transport gives one). */
export interface Outbox {
  send(spaceId: string, text: string): Promise<string | undefined>;
}

const HISTORY_LINES = 30;
const APPROVE = new Set(["👍", "like", "liked", "thumbsup", "+1"]);

/** "p:0/GUID" and "GUID" refer to the same message; compare on the bare id. */
function sameMessage(a: string, b: string): boolean {
  const bare = (id: string) => id.replace(/^p:\d+\//, "").split(":")[0] ?? id;
  return bare(a) === bare(b);
}

/**
 * Turns chat events into agent turns, approvals, and settlements. Transport-agnostic: the iMessage
 * bridge and the terminal simulator both drive it.
 */
export class GroupHandler {
  private history = new Map<string, ChatLine[]>();
  private queue = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly treasury: Treasury,
    private readonly out: Outbox,
    /** The Claude calls, swappable so tests can run without the API. */
    private readonly ai: { runTurn: typeof runTurn; readReceipt: typeof readReceipt } = {
      runTurn,
      readReceipt,
    },
  ) {}

  /** Handles events one at a time so two messages can't race on the same state. */
  private serial(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => console.error("handler error:", err));
    return this.queue;
  }

  private remember(spaceId: string, line: ChatLine): ChatLine[] {
    const lines = this.history.get(spaceId) ?? [];
    lines.push(line);
    if (lines.length > HISTORY_LINES) lines.splice(0, lines.length - HISTORY_LINES);
    this.history.set(spaceId, lines);
    return lines;
  }

  private async say(group: GroupState, text: string): Promise<string | undefined> {
    this.remember(group.spaceId, { from: "Treasury", text });
    return this.out.send(group.spaceId, text);
  }

  onText(spaceId: string, sender: Handle, text: string): Promise<void> {
    return this.serial(async () => {
      const group = this.store.group(spaceId);
      const member = this.store.ensureMember(group, sender);

      // A bare 👍 reply approves the sender's most recent open proposal (fallback for tapbacks).
      if (APPROVE.has(text.trim().toLowerCase())) {
        const open = [...group.proposals]
          .reverse()
          .find((p) => p.status === "pending" && requiredApprovers(p).includes(sender));
        if (open) {
          this.remember(spaceId, { from: member.name, text });
          await this.approve(group, open, sender);
          this.store.save();
          return;
        }
      }

      const history = [...(this.history.get(spaceId) ?? [])];
      this.remember(spaceId, { from: member.name, text });
      await this.agentTurn(group, sender, history, `${member.name}: ${text}`);
    });
  }

  onImage(spaceId: string, sender: Handle, bytes: Buffer): Promise<void> {
    return this.serial(async () => {
      const group = this.store.group(spaceId);
      const member = this.store.ensureMember(group, sender);
      const receipt = await this.ai.readReceipt(bytes);

      let event: string;
      if (receipt?.is_receipt) {
        const items = receipt.items.map((i) => `${i.name} $${i.price.toFixed(2)}`).join("; ");
        event =
          `[${member.name} posted a receipt from ${receipt.merchant || "unknown"}: subtotal $${receipt.subtotal.toFixed(2)}, ` +
          `tax $${receipt.tax.toFixed(2)}, tip $${receipt.tip.toFixed(2)}, total $${receipt.total.toFixed(2)} ${receipt.currency}. Items: ${items || "not listed"}]`;
      } else {
        event = `[${member.name} posted a photo that isn't a receipt]`;
      }
      const history = [...(this.history.get(spaceId) ?? [])];
      this.remember(spaceId, { from: member.name, text: event });
      await this.agentTurn(group, sender, history, event);
    });
  }

  onReaction(
    spaceId: string,
    sender: Handle,
    emoji: string,
    targetMessageId: string,
  ): Promise<void> {
    return this.serial(async () => {
      if (!APPROVE.has(emoji.trim().toLowerCase())) return;
      const group = this.store.group(spaceId);
      this.store.ensureMember(group, sender);
      const proposal = group.proposals.find(
        (p) => p.cardMessageId !== undefined && sameMessage(p.cardMessageId, targetMessageId),
      );
      if (!proposal || proposal.status !== "pending") return;
      await this.approve(group, proposal, sender);
      this.store.save();
    });
  }

  private async agentTurn(group: GroupState, sender: Handle, history: ChatLine[], event: string) {
    const { reply, newProposals } = await this.ai.runTurn(this.store, {
      group,
      sender,
      history,
      event,
    });
    if (reply) await this.say(group, reply);
    for (const proposal of newProposals) {
      proposal.cardMessageId = await this.say(group, cardText(group, proposal));
    }
    this.store.save();
  }

  /** Records a 👍 and settles once everyone in the split has approved. Pure code, no LLM. */
  private async approve(group: GroupState, proposal: Proposal, sender: Handle) {
    if (!requiredApprovers(proposal).includes(sender) || proposal.approvals.includes(sender))
      return;
    proposal.approvals.push(sender);
    if (!isFullyApproved(proposal)) return;

    const result = await this.treasury.settle(group, proposal);
    proposal.settlement = result;
    if (result.ok) {
      proposal.status = "settled";
      await this.say(
        group,
        `✅ Settled #${proposal.number} ${proposal.title} (${formatUsd(proposal.total)})\n${describeTransfers(group, result.transfers)}${result.reference ? `\nref ${result.reference}` : ""}`,
      );
    } else {
      proposal.status = "rejected";
      await this.say(
        group,
        `⛔️ Couldn't settle #${proposal.number}: ${result.error}. Nothing was charged. ${memberName(group, proposal.payer)}, want me to redo the split?`,
      );
    }
  }
}
