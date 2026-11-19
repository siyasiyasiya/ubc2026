import { usdc, type ChatPort, type IncomingMessage, type IncomingReaction, type PullParams, type Receipt, type WalletAdapter } from "@gta/core";
import type { runTurn as RunTurn } from "@gta/agent";
import { groupIdForChat, InMemoryWalletAdapter, inviteTicket } from "@gta/wallet";
import { describe, expect, it } from "vitest";
import { GroupRuntime } from "./runtime.js";
import { Store } from "./store.js";

const NEENA = "+1001";
const SIYA = "+1002";
const TRISTAN = "+1003";
const OUTSIDER = "+1999";
const CHAT = "group";

/** A runtime whose "agent" proposes a $90 dinner paid by Neena, split three ways. */
function setup(limitUsd = 200, opts: { wallet?: (chatId: string) => WalletAdapter; wallets?: Record<string, string>; invites?: { baseUrl: string; secret: string }; chats?: string[]; participants?: string[] } = {}) {
  const posted: { id: string; text: string }[] = [];
  const failing = { posts: 0, dms: 0 };
  const dms: { handle: string; text: string }[] = [];
  const onMessage: ((m: IncomingMessage) => void)[] = [];
  const onReaction: ((r: IncomingReaction) => void)[] = [];
  const chat: ChatPort = {
    async postMessage(chatId, text) {
      if (failing.posts > 0) {
        failing.posts--;
        throw new Error("chat unreachable");
      }
      const id = `msg-${posted.length + 1}`;
      posted.push({ id, text });
      return { id, chatId };
    },
    postImage: async (chatId) => ({ id: "img", chatId }),
    sendDirectMessage: async (handle, text) => {
      if (failing.dms > 0) {
        failing.dms--;
        throw new Error("no DMs");
      }
      dms.push({ handle, text });
      return { id: "dm", chatId: handle };
    },
    onMessage: (h) => (onMessage.push(h), () => undefined),
    onReaction: (h) => (onReaction.push(h), () => undefined),
    getParticipants: async () => opts.participants ?? [],
  };
  const fakeTurn: typeof RunTurn = async ({ actions, event }) => {
    if (event.includes("join me")) return actions.sendJoinLink({});
    if (event.includes("trip plan")) return actions.setGroupPlan({ usd: 200, period: "once" });
    if (event.includes("settle up")) return actions.settleUp();
    if (event.includes("leave kitty")) return actions.leave();
    if (event.includes("tab dinner")) {
      return actions.proposeReimbursement({ title: "Dinner", totalUsd: 90, payer: "Neena", participants: ["Neena", "Siya", "Tristan"], settle: "tab" });
    }
    const limit = /limit (\d+)/.exec(event);
    if (limit) return actions.setMyLimit({ usd: Number(limit[1]), period: "weekly" });
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
    ...(opts.invites ? { invites: opts.invites } : {}),
    ...(opts.chats ? { chats: opts.chats } : {}),
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
  return { posted, dms, failing, say, react, proposeDinner, request, runtime, store };
}

describe("GroupRuntime", () => {
  it("posts a card and settles once both participants 👍 it", async () => {
    const t = setup();
    const req = await t.proposeDinner();
    expect(req.state.name).toBe("awaiting_approval");
    expect(t.posted.find((p) => p.id === req.previewMessageId)?.text).toContain("#1 Dinner: $90.00");
    expect(t.posted.some((p) => p.text.startsWith("Who paid?"))).toBe(false); // payer and amount were already given

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

  it("matches a 👍 to the sender's open card when the card only has a local id", async () => {
    const t = setup();
    const req = await t.proposeDinner();
    req.previewMessageId = "local:abc"; // the chat port never saw the sent row's real guid
    await t.react(SIYA, "REAL-GUID-1");
    await t.react(TRISTAN, "REAL-GUID-1");
    expect(t.request().state.name).toBe("done");
  });

  it("ignores a 👍 on some other message when the card has a real id", async () => {
    const t = setup();
    await t.proposeDinner();
    await t.react(SIYA, "SOME-OTHER-MESSAGE");
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

  it("says nothing moved (not 'still owed') when someone isn't set up yet", async () => {
    const inner = new InMemoryWalletAdapter();
    const wallet: WalletAdapter = {
      id: "arc-like",
      getLimitStatus: (m) => inner.getLimitStatus(m),
      canPull: (m, a) => inner.canPull(m, a),
      pull: async () => ({ status: "failed", reason: "hasn't linked a wallet yet" }),
    };
    const t = setup(200, { wallet });
    const req = await t.proposeDinner();
    await t.react(SIYA, req.previewMessageId!);
    await t.react(TRISTAN, req.previewMessageId!);
    expect(t.posted.some((p) => p.text.includes("Siya → Neena $30.00 ✗ not set up in Kitty yet, nothing moved"))).toBe(true);
  });

  it("stays quiet when the agent has nothing to say", async () => {
    const t = setup();
    await t.say(SIYA, "lol");
    expect(t.posted).toEqual([]);
  });

  it("seeds every chat participant as a member on first contact, without them speaking", async () => {
    const t = setup(200, { participants: [NEENA, SIYA, TRISTAN] });
    await t.say(NEENA, "hey"); // only Neena speaks
    const members = t.store.get(CHAT)!.group.members.map((m) => m.id);
    expect(members).toContain(SIYA);
    expect(members).toContain(TRISTAN);
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

  it("links a Face ID join to the invited member and announces it without the limit", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites });
    await t.say(SIYA, "hi");
    const link = new URL(t.runtime.inviteLinkFor(CHAT, SIYA));
    expect(link.searchParams.get("t")).toBe(inviteTicket(invites.secret, CHAT, SIYA));
    expect(link.searchParams.get("n")).toBe("Siya");

    const account = "0x00000000000000000000000000000000000000Cc" as const;
    const base = { group: groupIdForChat(CHAT), account, blockNumber: 1n, txHash: "0x01" as const };
    const joined = await t.runtime.handleJoin({ ...base, ticket: inviteTicket(invites.secret, CHAT, SIYA), limit: { amount: usdc(40), period: "monthly" } });
    expect(joined).toEqual({ chatId: CHAT, handle: SIYA });
    const siya = t.store.get(CHAT)!.group.members.find((m) => m.id === SIYA)!;
    expect(siya.wallet?.address).toBe(account);
    expect(siya.limit).toEqual({ amount: usdc(40), period: "monthly" });
    expect(t.posted.at(-1)?.text).toMatch(/Siya\b.*\b(in|joined|set|kitty)\b/i);

    const stranger = await t.runtime.handleJoin({ ...base, ticket: inviteTicket("guess", CHAT, SIYA), limit: { amount: usdc(1), period: "weekly" } });
    expect(stranger).toBeUndefined();
  });

  it("gives a new ticket per invite, so someone can rejoin, and handles a replayed join once", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites });
    const first = new URL(t.runtime.inviteLinkFor(CHAT, SIYA)).searchParams.get("t") as `0x${string}`;
    const second = new URL(t.runtime.inviteLinkFor(CHAT, SIYA)).searchParams.get("t") as `0x${string}`;
    expect(second).not.toBe(first);
    expect(second).toBe(inviteTicket(invites.secret, CHAT, SIYA, 1));

    const join = (ticket: `0x${string}`, account: `0x${string}`) =>
      t.runtime.handleJoin({ group: groupIdForChat(CHAT), account, ticket, limit: { amount: usdc(30), period: "weekly" }, blockNumber: 1n, txHash: "0x01" });
    const a = "0x00000000000000000000000000000000000000a1" as const;
    const b = "0x00000000000000000000000000000000000000b2" as const;
    expect(await join(first, a)).toEqual({ chatId: CHAT, handle: SIYA });
    const posts = t.posted.length;
    expect(await join(first, a)).toEqual({ chatId: CHAT, handle: SIYA }); // replay: no second announcement
    expect(t.posted.length).toBe(posts);
    expect(await join(second, b)).toEqual({ chatId: CHAT, handle: SIYA }); // new phone, new account
    expect(t.store.get(CHAT)!.group.members.find((m) => m.id === SIYA)!.wallet?.address).toBe(b);
  });

  it("matches a CLI invite for someone who hasn't spoken in a chat the bot hasn't seen yet", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites, chats: ["fresh-chat"] });
    const ticket = inviteTicket(invites.secret, "fresh-chat", TRISTAN); // what the CLI mints (nonce 0)
    const joined = await t.runtime.handleJoin({
      group: groupIdForChat("fresh-chat"),
      account: "0x00000000000000000000000000000000000000c3",
      ticket,
      limit: { amount: usdc(10), period: "weekly" },
      blockNumber: 1n,
      txHash: "0x01",
    });
    expect(joined).toEqual({ chatId: "fresh-chat", handle: TRISTAN });
    expect(t.store.get("fresh-chat")!.group.members.find((m) => m.id === TRISTAN)?.displayName).toBe("Tristan");
  });

  it("still announces a join when the first post failed and the watcher retries", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites, chats: [CHAT] });
    const event = {
      group: groupIdForChat(CHAT),
      account: "0x00000000000000000000000000000000000000d4" as const,
      ticket: inviteTicket(invites.secret, CHAT, SIYA),
      limit: { amount: usdc(10), period: "weekly" as const },
      blockNumber: 1n,
      txHash: "0x01" as const,
    };
    t.failing.posts = 1;
    await expect(t.runtime.handleJoin(event)).rejects.toThrow("chat unreachable");
    expect(await t.runtime.handleJoin(event)).toEqual({ chatId: CHAT, handle: SIYA });
    expect(t.posted.at(-1)?.text).toMatch(/Siya\b.*\b(in|joined|set|kitty)\b/i);
  });

  it("texts a join link to someone who isn't set up, and falls back to the group if DMs fail", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites });
    await t.say(SIYA, "join me");
    expect(t.dms).toHaveLength(0); // no plan yet: ask the chat first, never send the server's default
    expect(t.posted.at(-1)?.text).toContain("no plan yet");

    await t.say(NEENA, "trip plan please");
    await t.say(SIYA, "join me");
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0]!.handle).toBe(SIYA);
    const joinLink = new URL(t.dms[0]!.text.split(" ").at(-1)!);
    expect(joinLink.searchParams.get("t")).toBe(inviteTicket(invites.secret, CHAT, SIYA));
    expect(joinLink.searchParams.get("l")).toBe("200.00"); // the chat's plan, not DEFAULT_LIMIT_USD
    expect(joinLink.searchParams.get("p")).toBe("once");
    expect(t.posted.at(-1)?.text).toBe("Texted Siya a private Face ID link.");

    t.failing.dms = 1;
    await t.say(TRISTAN, "join me");
    expect(t.posted.some((p) => p.text.startsWith("Tristan:") && p.text.includes("kitty"))).toBe(true);
  });

  it("lowers a limit onchain right away but sends a Face ID link to raise it", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const lowered: bigint[] = [];
    const inner = new InMemoryWalletAdapter();
    const wallet: WalletAdapter = {
      id: "arc-like",
      getLimitStatus: async (m) => ({ limit: { amount: usdc(50), period: "weekly" }, remaining: usdc(50) }),
      canPull: (m, a) => inner.canPull(m, a),
      pull: async () => ({ status: "pulled" }),
      lowerLimit: async (_m, amount) => void lowered.push(amount),
    };
    const t = setup(200, { invites, wallet, wallets: { [SIYA]: "0x00000000000000000000000000000000000000bb" } });
    await t.say(SIYA, "set my limit 20");
    expect(lowered).toEqual([usdc(20)]);
    expect(t.dms).toHaveLength(0);

    await t.say(SIYA, "set my limit 80");
    expect(lowered).toHaveLength(1);
    const link = new URL(t.dms[0]!.text.split(" ").at(-1)!);
    expect(link.searchParams.get("t")).toBeNull();
    expect(link.searchParams.get("l")).toBe("80.00");
    expect(link.searchParams.get("p")).toBe("weekly");
  });

  it("texts a pay-back link when a share fails onchain for low balance", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const inner = new InMemoryWalletAdapter();
    const wallet: WalletAdapter = {
      id: "arc-like",
      getLimitStatus: (m) => inner.getLimitStatus(m),
      canPull: (m, a) => inner.canPull(m, a),
      pull: async (p) => (p.from.id === SIYA ? { status: "failed", reason: "transfer failed", txRef: "0xtx" } : { status: "pulled", txRef: "0xok" }),
    };
    const wallets = {
      [NEENA]: "0x00000000000000000000000000000000000000aa",
      [SIYA]: "0x00000000000000000000000000000000000000bb",
      [TRISTAN]: "0x00000000000000000000000000000000000000cc",
    };
    const t = setup(200, { invites, wallet, wallets });
    const req = await t.proposeDinner();
    await t.say(SIYA, "👍");
    await t.say(TRISTAN, "👍");
    expect(t.posted.some((p) => p.text.includes("Siya → Neena $30.00 ✗ not enough in their Kitty account (still owed)"))).toBe(true);
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0]!.handle).toBe(SIYA);
    const link = new URL(t.dms[0]!.text.split(" ").at(-1)!);
    expect(link.searchParams.get("r")).toBe(wallets[NEENA]);
    expect(link.searchParams.get("o")).toBe("Neena");
    expect(link.searchParams.get("m")).toBe("30.00");
    expect(req.number).toBe(1);

    await t.runtime.handleDebtPaid({ debtor: wallets[SIYA] as `0x${string}`, creditor: wallets[NEENA] as `0x${string}`, amount: usdc(30), blockNumber: 1n, txHash: "0x01" });
    const paid = t.posted.at(-1)?.text ?? "";
    expect(paid).toContain("Siya");
    expect(paid).toContain("Neena");
    expect(paid).toContain("$30.00");
  });

  it("confirms a member's own Face ID limit change without the amount", async () => {
    const account = "0x00000000000000000000000000000000000000bb" as const;
    const t = setup(200, { wallets: { [SIYA]: account } });
    await t.say(SIYA, "hi");
    const base = { group: groupIdForChat(CHAT), account, blockNumber: 1n, txHash: "0x01" as const };
    await t.runtime.handleLimitSet({ ...base, limit: { amount: usdc(75), period: "weekly" }, by: account });
    const limitMsg = t.posted.at(-1)?.text ?? "";
    expect(limitMsg).toContain("Siya");
    expect(limitMsg).toContain("limit");
    expect(t.store.get(CHAT)!.group.members.find((m) => m.id === SIYA)!.limit.amount).toBe(usdc(75));
    const posts = t.posted.length;
    await t.runtime.handleLimitSet({ ...base, limit: { amount: usdc(10), period: "weekly" }, by: "0x00000000000000000000000000000000000000ee" });
    expect(t.posted.length).toBe(posts); // operator lowered it; the bot already replied in chat
  });

  it("a trip plan makes join links one-time", async () => {
    const invites = { baseUrl: "https://kittyagent.vercel.app", secret: "s3cret" };
    const t = setup(200, { invites });
    await t.say(NEENA, "trip plan please");
    expect(t.posted.at(-1)?.text).toBe("Group's plan is now $200.00 each in total.");
    await t.say(SIYA, "join me");
    const link = new URL(t.dms.at(-1)!.text.split(" ").at(-1)!);
    expect(link.searchParams.get("l")).toBe("200.00");
    expect(link.searchParams.get("p")).toBe("once");
    expect(t.store.get(CHAT)!.group.kind).toBe("trip");
  });

  it("holds tab splits until settle up, then settles them together", async () => {
    const t = setup();
    for (const who of [SIYA, TRISTAN]) await t.say(who, "hi");
    await t.say(NEENA, "tab dinner");
    const req = t.request();
    expect(req.onTab).toBe(true);
    await t.say(SIYA, "👍");
    await t.say(TRISTAN, "👍");
    expect(t.request().state.name).toBe("settling"); // approved, held on the tab
    expect(t.posted.at(-1)?.text).toContain("is on the tab");

    await t.say(NEENA, "settle up");
    expect(t.request().state.name).toBe("done");
    expect(t.posted.some((p) => p.text.includes("✅ Settled #1 Dinner"))).toBe(true);
    expect(t.posted.at(-1)?.text).toBe("Settled 1 from the tab.");
  });

  it("leaving stops the contract pulling and keeps the member's history", async () => {
    const removed: string[] = [];
    const inner = new InMemoryWalletAdapter();
    const wallet: WalletAdapter = {
      id: "arc-like",
      getLimitStatus: (m) => inner.getLimitStatus(m),
      canPull: (m, a) => inner.canPull(m, a),
      pull: async () => ({ status: "pulled" }),
      removeMember: async (m) => void removed.push(m.id),
    };
    const t = setup(200, { wallet, wallets: { [SIYA]: "0x00000000000000000000000000000000000000bb" } });
    await t.say(SIYA, "leave kitty");
    expect(removed).toEqual([SIYA]);
    expect(t.store.get(CHAT)!.group.members.find((m) => m.id === SIYA)!.wallet).toBeUndefined();
    expect(t.posted.at(-1)?.text).toContain("Siya left.");
  });

  it("passes errors back from run() so the join watcher retries instead of skipping", async () => {
    const t = setup();
    await expect(t.runtime.run(async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(await t.runtime.run(async () => 42)).toBe(42); // the queue keeps going afterwards
  });
});
