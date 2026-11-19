import { usdc, type ChatPort, type IncomingMessage, type IncomingReaction, type PullParams, type Receipt, type WalletAdapter } from "@gta/core";
import type { runTurn as RunTurn } from "@gta/agent";
import { InMemoryWalletAdapter } from "@gta/wallet";
import { describe, expect, it } from "vitest";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

const NEENA = "+1001";
const SIYA = "+1002";
const TRISTAN = "+1003";
const OUTSIDER = "+1999";
const CHAT = "group";

/** A runtime whose "agent" proposes a $90 dinner paid by Neena, split three ways. */
function setup(limitUsd = 200, opts: { wallet?: (chatId: string) => WalletAdapter; wallets?: Record<string, string> } = {}) {
  const posted: { id: string; text: string }[] = [];
  const onMessage: ((m: IncomingMessage) => void)[] = [];
  const onReaction: ((r: IncomingReaction) => void)[] = [];
  const chat: ChatPort = {
    async postMessage(chatId, text) {
      const id = `msg-${posted.length + 1}`;
      posted.push({ id, text });
      return { id, chatId };
    },
    postImage: async (chatId) => ({ id: "img", chatId }),
    sendDirectMessage: async (handle) => ({ id: "dm", chatId: handle }),
    onMessage: (h) => (onMessage.push(h), () => undefined),
    onReaction: (h) => (onReaction.push(h), () => undefined),
  };
  const fakeTurn: typeof RunTurn = async ({ actions, event }) => {
    if (!event.includes("split dinner")) return null;
    await actions.proposeReimbursement({
      title: "Dinner",
      totalUsd: 90,
      payer: "Neena",
      participants: ["Neena", "Siya", "Tristan"],
    });
    return "Splitting dinner three ways.";
  };
  const store = new Store();
  const runtime = new GroupRuntime({
    chat,
    wallet: opts.wallet ?? new InMemoryWalletAdapter(),
    ...(opts.wallets ? { wallets: opts.wallets } : {}),
    receipts: { read: async (): Promise<Receipt> => ({ source: "photo", total: usdc(90), at: 0 }) },
    runTurn: fakeTurn,
    store,
    defaultLimit: { amount: usdc(limitUsd), period: "weekly" },
    names: { [NEENA]: "Neena", [SIYA]: "Siya", [TRISTAN]: "Tristan", [OUTSIDER]: "Mallory" },
    log: () => undefined,
  });
  runtime.attach();

  const say = async (handle: string, text: string) => {
    onMessage.forEach((h) => h({ chatId: CHAT, senderHandle: handle, text, attachments: [], at: 0 }));
    await runtime.serial(async () => undefined);
  };
  const react = async (handle: string, targetMessageId: string, emoji = "👍") => {
    onReaction.forEach((h) => h({ chatId: CHAT, senderHandle: handle, targetMessageId, emoji, added: true, at: 0 }));
    await runtime.serial(async () => undefined);
  };
  const request = () => store.get(CHAT)!.requests[0]!;

  const proposeDinner = async () => {
    for (const who of [SIYA, TRISTAN, OUTSIDER]) await say(who, "hi");
    await say(NEENA, "split dinner with siya and tristan");
    return request();
  };
  return { posted, say, react, proposeDinner, request };
}

describe("GroupRuntime", () => {
  it("posts a card and settles once both participants 👍 it", async () => {
    const t = setup();
    const req = await t.proposeDinner();
    expect(req.state.name).toBe("awaiting_approval");
    expect(t.posted.find((p) => p.id === req.previewMessageId)?.text).toContain("#1 Dinner: $90.00");

    await t.react(SIYA, req.previewMessageId!);
    expect(t.request().state.name).toBe("awaiting_approval");
    await t.react(TRISTAN, `p:0/${req.previewMessageId}`);
    expect(t.request().state.name).toBe("done");
    expect(t.posted.at(-1)!.text).toMatch(/Settled #1 Dinner \(\$90\.00\)\nSiya → Neena \$30\.00 ✓\nTristan → Neena \$30\.00 ✓/);
  });

  it("ignores 👍 from outside the split and other emoji", async () => {
    const t = setup();
    const req = await t.proposeDinner();
    await t.react(OUTSIDER, req.previewMessageId!);
    await t.react(SIYA, req.previewMessageId!, "😂");
    await t.react(TRISTAN, req.previewMessageId!);
    expect(t.request().state.name).toBe("awaiting_approval");
  });

  it("accepts a bare 👍 text reply as approval", async () => {
    const t = setup();
    await t.proposeDinner();
    await t.say(SIYA, "👍");
    await t.say(TRISTAN, "👍");
    expect(t.request().state.name).toBe("done");
  });

  it("records what's still owed when a share is over someone's limit", async () => {
    const t = setup(20); // $20/week, each share is $30
    const req = await t.proposeDinner();
    await t.react(SIYA, req.previewMessageId!);
    await t.react(TRISTAN, req.previewMessageId!);
    const state = t.request().state;
    expect(state.name).toBe("done");
    if (state.name === "done") expect(state.debts.map((d) => d.memberId).sort()).toEqual([SIYA, TRISTAN]);
    expect(t.posted.at(-1)!.text).toContain("Partly settled #1");
    expect(t.posted.at(-1)!.text).toContain("over limit ($20.00 left this week) (still owed)");
  });

  it("stays quiet when the agent has nothing to say", async () => {
    const t = setup();
    await t.say(SIYA, "lol");
    expect(t.posted).toEqual([]);
  });

  it("pulls through the chat's own wallet adapter, between members' Kitty accounts", async () => {
    const chats: string[] = [];
    const pulls: PullParams[] = [];
    const inner = new InMemoryWalletAdapter();
    const perChat = (chatId: string): WalletAdapter => {
      chats.push(chatId);
      return {
        id: "per-chat",
        getLimitStatus: (m) => inner.getLimitStatus(m),
        canPull: (m, a) => inner.canPull(m, a),
        pull: async (p) => (pulls.push(p), { status: "pulled", txRef: "0xtx" }),
      };
    };
    const wallets = { [NEENA]: "0x00000000000000000000000000000000000000aa", [SIYA]: "0x00000000000000000000000000000000000000bb" };
    const t = setup(200, { wallet: perChat, wallets });
    const req = await t.proposeDinner();
    await t.react(SIYA, req.previewMessageId!);
    await t.react(TRISTAN, req.previewMessageId!);

    expect(new Set(chats)).toEqual(new Set([CHAT]));
    const fromSiya = pulls.find((p) => p.from.id === SIYA)!;
    expect(fromSiya.from.wallet?.address).toBe(wallets[SIYA]);
    expect(fromSiya.to).toEqual({ kind: "wallet", address: wallets[NEENA] });
    expect(pulls.find((p) => p.from.id === TRISTAN)?.from.wallet).toBeUndefined(); // hasn't joined yet
  });
});
