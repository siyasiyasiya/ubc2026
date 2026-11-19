import os from "node:os";
import { describe, expect, it } from "vitest";
import type {
  Attachment,
  Chat,
  ChatQuery,
  DispatchEvents,
  Message,
  MessageQuery,
  Reaction,
  ReactionKind,
  SendRequest,
} from "@photon-ai/imessage-kit";
import type { IncomingMessage, IncomingReaction } from "@gta/core";

import {
  PhotonChatPort,
  mapMessageRow,
  mapReactionRow,
  type PhotonSdk,
} from "./index.js";

// ----------------------------------------------------------------------------
// Fakes: a PhotonSdk that records sends and lets tests drive the watcher.
// The adapter still issues the real SDK calls (send/startWatching) against this
// injected double — nothing in the adapter under test is stubbed out.
// ----------------------------------------------------------------------------

class FakeSdk implements PhotonSdk {
  sends: SendRequest[] = [];
  watchEvents: DispatchEvents | undefined;
  startWatchingCalls = 0;
  closed = false;
  chats: Chat[] = [];
  listChatsCalls = 0;
  /** Rows `getMessages` returns, newest state last; the adapter polls this while waiting on a file. */
  messages: Message[] = [];
  getMessagesCalls = 0;

  async send(request: SendRequest): Promise<void> {
    this.sends.push(request);
  }
  async getMessages(query?: MessageQuery): Promise<readonly Message[]> {
    this.getMessagesCalls += 1;
    return query?.chatId ? this.messages.filter((m) => m.chatId === query.chatId) : this.messages;
  }
  async startWatching(events?: DispatchEvents): Promise<void> {
    this.startWatchingCalls += 1;
    this.watchEvents = events;
  }
  async stopWatching(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async listChats(query?: ChatQuery): Promise<readonly Chat[]> {
    this.listChatsCalls += 1;
    return query?.kind ? this.chats.filter((c) => c.kind === query.kind) : this.chats;
  }

  /** Simulate the watcher observing an inbound row. */
  emit(message: Message): void {
    this.watchEvents?.onIncomingMessage?.(message);
  }
}

// ----------------------------------------------------------------------------
// Row factories: full, strict-typed Message/Reaction/Attachment with overrides.
// ----------------------------------------------------------------------------

// A minute ahead of now, so fixture rows always count as new (not replayed history).
const AT = new Date(Date.now() + 60_000);
const ALLOWED = ["iMessage;+;chat123", "iMessage;+;chatABC"];
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeAttachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    fileName: "receipt.jpg",
    localPath: "/Users/me/Downloads/receipt.jpg",
    mimeType: "image/jpeg",
    uti: "public.jpeg",
    sizeBytes: 1234,
    transferStatus: "complete",
    isFromMe: false,
    isSticker: false,
    isSensitiveContent: false,
    altText: null,
    createdAt: AT,
    ...over,
  };
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    rowId: 1,
    id: "msg-guid-1",
    chatId: "iMessage;+;chat123",
    chatKind: "group",
    participant: "+15551230000",
    service: "iMessage",
    text: "we are out of paper towels",
    kind: "text",
    isFromMe: false,
    isRead: false,
    isSent: false,
    isDelivered: false,
    isDowngraded: false,
    didNotifyRecipient: false,
    isAutoReply: false,
    isSystem: false,
    isForwarded: false,
    isAudioMessage: false,
    isPlayed: false,
    isExpirable: false,
    hasError: false,
    errorCode: 0,
    isSpam: false,
    isContactKeyVerified: false,
    hasUnseenMention: false,
    wasDeliveredQuietly: false,
    isEmergencySos: false,
    isCriticalAlert: false,
    isOffGrid: false,
    createdAt: AT,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    editedAt: null,
    retractedAt: null,
    recoveredAt: null,
    replyToMessageId: null,
    threadRootMessageId: null,
    affectedParticipant: null,
    newGroupName: null,
    sendEffect: null,
    appBundleId: null,
    isInvisibleInkRevealed: false,
    expireStatus: "active",
    shareActivity: "none",
    shareDirection: "none",
    scheduleKind: "none",
    scheduleStatus: "none",
    segmentCount: 1,
    hasAttachments: false,
    reaction: null,
    attachments: [],
    ...over,
  };
}

function makeReaction(over: Partial<Reaction> = {}): Reaction {
  return {
    kind: "like",
    targetMessageId: "target-guid-1",
    emoji: null,
    textRange: { location: 0, length: 0 },
    isRemoved: false,
    ...over,
  };
}

/** A reaction arrives as a Message row with its `reaction` field populated. */
function makeReactionRow(reaction: Partial<Reaction> = {}): Message {
  return makeMessage({ reaction: makeReaction(reaction) });
}

function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    chatId: "iMessage;+;chat123",
    name: null,
    service: "iMessage",
    kind: "group",
    account: null,
    isArchived: false,
    isFiltered: false,
    dropsIncomingMessages: false,
    autoDeletesIncomingMessages: false,
    lastReadAt: null,
    unreadCount: 0,
    lastMessageAt: null,
    ...over,
  };
}

/** Let queued microtasks/timers run so async chat discovery can finish. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ----------------------------------------------------------------------------
// Pure mapping functions
// ----------------------------------------------------------------------------

describe("mapMessageRow", () => {
  it("maps a text message with attachments to IncomingMessage", () => {
    const row = makeMessage({
      attachments: [makeAttachment({ localPath: "/a/b.jpg", mimeType: "image/png" })],
    });
    expect(mapMessageRow(row)).toEqual<IncomingMessage>({
      chatId: "iMessage;+;chat123",
      senderHandle: "+15551230000",
      text: "we are out of paper towels",
      attachments: [{ uri: "/a/b.jpg", mimeType: "image/png" }],
      at: AT.getTime(),
    });
  });

  it("defaults null text and drops attachments with no local file", () => {
    const row = makeMessage({ text: null, attachments: [makeAttachment({ localPath: null })] });
    const mapped = mapMessageRow(row);
    expect(mapped?.text).toBe("");
    expect(mapped?.attachments).toEqual([]);
  });

  it("expands a ~ in the attachment path so the file can actually be opened", () => {
    const row = makeMessage({
      text: null,
      attachments: [makeAttachment({ localPath: "~/Library/Messages/Attachments/e1/01/x/IMG_0957.heic", mimeType: "image/heic" })],
    });
    const uri = mapMessageRow(row)?.attachments[0]?.uri;
    expect(uri?.startsWith("~")).toBe(false);
    expect(uri).toBe(`${os.homedir()}/Library/Messages/Attachments/e1/01/x/IMG_0957.heic`);
  });

  it("looks up a missing sender, and drops the message if nobody can be credited", () => {
    const row = makeMessage({ participant: null });
    expect(mapMessageRow(row)).toBeNull();
    expect(mapMessageRow(row, () => "+18475550000")?.senderHandle).toBe("+18475550000");
  });

  it("returns null for a reaction row (not a plain message)", () => {
    expect(mapMessageRow(makeReactionRow())).toBeNull();
  });

  it("returns null when the chat cannot be resolved", () => {
    expect(mapMessageRow(makeMessage({ chatId: null }))).toBeNull();
  });
});

describe("mapReactionRow", () => {
  it("maps a 👍 'like' add to IncomingReaction (added=true)", () => {
    expect(mapReactionRow(makeReactionRow({ kind: "like", isRemoved: false })))
      .toEqual<IncomingReaction>({
        chatId: "iMessage;+;chat123",
        senderHandle: "+15551230000",
        targetMessageId: "target-guid-1",
        emoji: "👍",
        added: true,
        at: AT.getTime(),
      });
  });

  it("maps a 👍 'like' removal to added=false", () => {
    const mapped = mapReactionRow(makeReactionRow({ kind: "like", isRemoved: true }));
    expect(mapped?.added).toBe(false);
    expect(mapped?.emoji).toBe("👍");
  });

  it("maps a free-form 👍 emoji reaction", () => {
    const mapped = mapReactionRow(makeReactionRow({ kind: "emoji", emoji: "👍" }));
    expect(mapped?.emoji).toBe("👍");
    expect(mapped?.added).toBe(true);
  });

  it("ignores non-thumbs-up tapbacks", () => {
    const others: ReactionKind[] = ["love", "dislike", "laugh", "emphasize", "question"];
    for (const kind of others) {
      expect(mapReactionRow(makeReactionRow({ kind }))).toBeNull();
    }
    // An emoji reaction that is not 👍 is ignored too.
    expect(mapReactionRow(makeReactionRow({ kind: "emoji", emoji: "🎉" }))).toBeNull();
  });

  it("returns null when there is no target message", () => {
    expect(mapReactionRow(makeReactionRow({ targetMessageId: null }))).toBeNull();
  });

  it("returns null for a non-reaction row", () => {
    expect(mapReactionRow(makeMessage())).toBeNull();
  });

  it("strips the p:N/ prefix so the target matches the message id", () => {
    const mapped = mapReactionRow(makeReactionRow({ targetMessageId: "p:0/target-guid-1" }));
    expect(mapped?.targetMessageId).toBe("target-guid-1");
  });

  it("looks up the sender when a group reaction arrives with participant null", () => {
    // Seen live: a 👍 from a group member came through with participant null.
    const row = { ...makeReactionRow({ kind: "like" }), participant: null };
    expect(mapReactionRow(row)).toBeNull();
    const mapped = mapReactionRow(row, (id) => (id === row.id ? "+18475550000" : null));
    expect(mapped?.senderHandle).toBe("+18475550000");
  });

  it("ignores my own reactions", () => {
    const row = { ...makeReactionRow({ kind: "like" }), isFromMe: true };
    expect(mapReactionRow(row, () => "+15550000000")).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// PhotonChatPort — real adapter against the injected fake SDK
// ----------------------------------------------------------------------------

describe("PhotonChatPort send paths", () => {
  it("postMessage sends { to, text } and falls back to a local ref if the row never appears", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, sentIdTimeoutMs: 10 });
    const ref = await port.postMessage("iMessage;+;chatABC", "hello group");
    expect(sdk.sends).toEqual([{ to: "iMessage;+;chatABC", text: "hello group" }]);
    expect(ref.chatId).toBe("iMessage;+;chatABC");
    expect(ref.id).toMatch(/^local:/);
  });

  it("postMessage returns the real chat.db id once the sent row shows up", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, sentIdTimeoutMs: 1000 });
    const pending = port.postMessage("iMessage;+;chatABC", "🧾 #1 Dinner");
    await tick();
    // Another of my messages in a different chat doesn't match; the right one does.
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "other", chatId: "iMessage;+;elsewhere", text: "🧾 #1 Dinner", isFromMe: true }));
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "card-guid", chatId: "iMessage;+;chatABC", text: "🧾 #1 Dinner", isFromMe: true }));
    expect(await pending).toEqual({ id: "card-guid", chatId: "iMessage;+;chatABC" });
  });

  it("postImage sends the local file path as an attachment with an optional caption", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, sentIdTimeoutMs: 10 });
    await port.postImage(
      "iMessage;+;chatABC",
      { uri: "/Users/me/Pictures/cart.png", mimeType: "image/png" },
      "Approve this cart?",
    );
    expect(sdk.sends).toEqual([
      {
        to: "iMessage;+;chatABC",
        text: "Approve this cart?",
        attachments: ["/Users/me/Pictures/cart.png"],
      },
    ]);
  });

  it("postImage learns the sent card's id so a 👍 on the screenshot can be matched", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, sentIdTimeoutMs: 1000 });
    const pending = port.postImage("iMessage;+;chat123", { uri: "/cart.png", mimeType: "image/png" }, "🛒 approve?");
    await tick();
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "card-img", isFromMe: true, participant: null, text: "🛒 approve?" }));
    expect((await pending).id).toBe("card-img");
  });

  it("sendDirectMessage sends to a bare handle", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const ref = await port.sendDirectMessage("+15559990000", "your share is $12");
    expect(sdk.sends).toEqual([{ to: "+15559990000", text: "your share is $12" }]);
    expect(ref.chatId).toBe("+15559990000");
  });
});

describe("PhotonChatPort watcher", () => {
  it("delivers incoming messages to onMessage handlers", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    sdk.emit(makeMessage({ text: "buy milk" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("buy milk");
  });

  it("delivers a ready attachment right away (no waiting)", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    sdk.emit(makeMessage({ text: "", hasAttachments: true, attachments: [makeAttachment()] }));

    expect(received).toHaveLength(1);
    expect(received[0]?.attachments).toHaveLength(1);
    expect(sdk.getMessagesCalls).toBe(0); // the file was already on disk, no re-query
  });

  it("waits for a still-downloading attachment, then delivers it once the file lands", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, attachmentWaitMs: 500, attachmentPollMs: 5 });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    // The row appears before its attachment's file is on disk (WAL race: join not flushed yet).
    sdk.emit(makeMessage({ id: "receipt-1", text: "", hasAttachments: true, attachments: [] }));
    expect(received).toHaveLength(0); // nothing delivered yet, we're waiting on the file

    // The download finishes; a re-query now returns the complete row.
    sdk.messages = [
      makeMessage({ id: "receipt-1", text: "", hasAttachments: true, attachments: [makeAttachment()] }),
    ];
    await new Promise((r) => setTimeout(r, 40));

    expect(received).toHaveLength(1);
    expect(received[0]?.attachments).toEqual([
      { uri: "/Users/me/Downloads/receipt.jpg", mimeType: "image/jpeg" },
    ]);
    expect(sdk.getMessagesCalls).toBeGreaterThan(0);
  });

  it("gives up after the timeout and delivers any text if the attachment never lands", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({
      sdk,
      allowedChatIds: ALLOWED,
      attachmentWaitMs: 20,
      attachmentPollMs: 5,
      log: () => undefined,
    });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    const stuck = makeMessage({ id: "stuck-1", text: "here's the receipt", hasAttachments: true, attachments: [] });
    sdk.emit(stuck);
    sdk.messages = [stuck]; // re-queries keep seeing no file
    await new Promise((r) => setTimeout(r, 60));

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("here's the receipt");
    expect(received[0]?.attachments).toEqual([]);
  });

  it("delivers an incoming attachment the live watcher missed, via the chat.db poller", async () => {
    const sdk = new FakeSdk();
    // The watcher never emits this row; only getMessages returns it (the real Photon behaviour).
    sdk.messages = [makeMessage({ id: "poll-1", text: "￼", hasAttachments: true, attachments: [makeAttachment()] })];
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, attachmentPollEveryMs: 10_000 });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start(); // starts the poller, which runs one scan immediately
    await tick();
    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]?.attachments).toHaveLength(1);
    expect(received[0]?.text).toBe(""); // the U+FFFC placeholder is stripped
    await port.close();
  });

  it("the poller skips our own sends and never double-delivers", async () => {
    const sdk = new FakeSdk();
    sdk.messages = [
      makeMessage({ id: "mine", isFromMe: true, text: "", hasAttachments: true, attachments: [makeAttachment()] }),
      makeMessage({ id: "theirs", text: "", hasAttachments: true, attachments: [makeAttachment()] }),
    ];
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, attachmentPollEveryMs: 5 });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start();
    await new Promise((r) => setTimeout(r, 40)); // let several poll ticks run

    expect(received.map((m) => m.senderHandle)).toHaveLength(1); // only "theirs", once (not from-me, not repeated)
    await port.close();
  });

  it("routes a 👍 reaction to onReaction and NOT to onMessage", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const messages: IncomingMessage[] = [];
    const reactions: IncomingReaction[] = [];
    port.onMessage((m) => messages.push(m));
    port.onReaction((r) => reactions.push(r));

    sdk.emit(makeReactionRow({ kind: "like" }));

    expect(messages).toHaveLength(0);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.emoji).toBe("👍");
    expect(reactions[0]?.added).toBe(true);
    expect(reactions[0]?.targetMessageId).toBe("target-guid-1");
  });

  it("starts exactly one watcher even with both subscriptions", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    port.onMessage(() => {});
    port.onReaction(() => {});
    expect(sdk.startWatchingCalls).toBe(1);
  });

  it("unsubscribe stops delivering to a handler", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const received: IncomingMessage[] = [];
    const unsubscribe = port.onMessage((m) => received.push(m));

    sdk.emit(makeMessage({ text: "first" }));
    unsubscribe();
    sdk.emit(makeMessage({ text: "second" }));

    expect(received.map((m) => m.text)).toEqual(["first"]);
  });

  it("surfaces watcher errors through the onError config hook", () => {
    const sdk = new FakeSdk();
    const errors: Error[] = [];
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, onError: (e) => errors.push(e) });
    port.onMessage(() => {});

    const boom = new Error("db locked");
    sdk.watchEvents?.onError?.(boom);

    expect(errors).toEqual([boom]);
  });

  it("close releases the SDK", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    port.onMessage(() => {});
    await port.close();
    expect(sdk.closed).toBe(true);
  });
});

describe("PhotonChatPort allowlist, self handle, and echoes", () => {
  it("only surfaces allowlisted chats", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ["iMessage;+;chat123"], log: () => undefined });
    const seen: IncomingMessage[] = [];
    port.onMessage((m) => seen.push(m));
    sdk.watchEvents?.onIncomingMessage?.(makeMessage({ chatId: "iMessage;+;elsewhere" }));
    sdk.watchEvents?.onIncomingMessage?.(makeMessage({ chatId: "iMessage;+;chat123" }));
    expect(seen.map((m) => m.chatId)).toEqual(["iMessage;+;chat123"]);
  });

  it("ignores my own messages unless selfHandle is set", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const seen: IncomingMessage[] = [];
    port.onMessage((m) => seen.push(m));
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ isFromMe: true, participant: null, text: "dinner?" }));
    expect(seen).toEqual([]);
  });

  it("treats my own messages and 👍s as selfHandle, but never the bot's own sends", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, selfHandle: "+16148001324", sentIdTimeoutMs: 1000 });
    const messages: IncomingMessage[] = [];
    const reactions: IncomingReaction[] = [];
    port.onMessage((m) => messages.push(m));
    port.onReaction((r) => reactions.push(r));

    // The bot posts a card; its from-me row is matched to the send and not treated as input.
    const pending = port.postMessage("iMessage;+;chat123", "🧾 #1 Dinner");
    await tick();
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "card", isFromMe: true, participant: null, text: "🧾 #1 Dinner" }));
    expect((await pending).id).toBe("card");

    // A late duplicate echo of the same text is still ignored.
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "echo", isFromMe: true, participant: null, text: "🧾 #1 Dinner" }));
    // Neena typing on her phone is surfaced as her.
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "n1", isFromMe: true, participant: null, text: "split dinner" }));
    // Neena's 👍 on the card counts as her approval.
    sdk.watchEvents?.onFromMeMessage?.({ ...makeReactionRow({ kind: "like", targetMessageId: "p:0/card" }), isFromMe: true, participant: null });

    expect(messages.map((m) => [m.senderHandle, m.text])).toEqual([["+16148001324", "split dinner"]]);
    expect(reactions.map((r) => [r.senderHandle, r.targetMessageId])).toEqual([["+16148001324", "card"]]);
  });

  it("refuses cloud mode", () => {
    expect(() => new PhotonChatPort({ sdk: new FakeSdk(), allowedChatIds: [], mode: "cloud" })).toThrow(/local/);
  });
});

describe("PhotonChatPort sent-message ids without text", () => {
  it("learns the card id from chat.db even when no watcher row has text", async () => {
    const sdk = new FakeSdk();
    const calls: [string, number, string[]][] = [];
    let row: string | null = null;
    const port = new PhotonChatPort({
      sdk,
      allowedChatIds: ALLOWED,
      sentIdPollMs: 5,
      sentIdTimeoutMs: 1000,
      sentIdLookup: (chatId, since, exclude) => {
        calls.push([chatId, since, [...exclude]]);
        return row && !exclude.has(row) ? row : null;
      },
    });
    const first = port.postMessage("iMessage;+;chat123", "Splitting dinner.");
    setTimeout(() => (row = "reply-guid"), 20);
    expect((await first).id).toBe("reply-guid");

    // The next send skips the id already claimed.
    const second = port.postMessage("iMessage;+;chat123", "🧾 #1 Dinner: $8.00\nPay back Siya: Joey $4.00");
    setTimeout(() => (row = "card-guid"), 20);
    expect((await second).id).toBe("card-guid");
    expect(calls.at(-1)?.[0]).toBe("iMessage;+;chat123");
    expect(calls.at(-1)?.[2]).toContain("reply-guid");
  });

  it("matches a text-less from-me row to the oldest send waiting in that chat", async () => {
    // Seen live: the card's chat.db row had text NULL (text lives in attributedBody).
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, sentIdTimeoutMs: 1000 });
    const pending = port.postMessage("iMessage;+;chat123", "🧾 #1 Dinner: $8.00\n👍 this message");
    await tick();
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "card", isFromMe: true, participant: null, text: null }));
    expect((await pending).id).toBe("card");
  });

  it("never passes a text-less, photo-less row on as input", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED, selfHandle: "+16148001324" });
    const seen: IncomingMessage[] = [];
    port.onMessage((m) => seen.push(m));
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "late", isFromMe: true, participant: null, text: null }));
    expect(seen).toEqual([]);
  });
});

describe("PhotonChatPort startup replay", () => {
  it("ignores rows created before the watcher started", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const messages: IncomingMessage[] = [];
    const reactions: IncomingReaction[] = [];
    port.onMessage((m) => messages.push(m));
    port.onReaction((r) => reactions.push(r));
    const old = new Date(Date.now() - 60_000);
    sdk.watchEvents?.onIncomingMessage?.(makeMessage({ createdAt: old }));
    sdk.watchEvents?.onIncomingMessage?.({ ...makeReactionRow({ kind: "like" }), createdAt: old });
    sdk.watchEvents?.onIncomingMessage?.(makeMessage({ id: "new", createdAt: new Date() }));
    expect(messages.map((m) => m.text)).toHaveLength(1);
    expect(reactions).toEqual([]);
  });
});

describe("PhotonChatPort getParticipants", () => {
  it("returns the chat roster, deduped and without the bot's own handle", async () => {
    const roster: Record<string, string[]> = { "iMessage;+;chat123": ["+1001", "+1002", "+1002", "+bot"] };
    const port = new PhotonChatPort({
      sdk: new FakeSdk(),
      allowedChatIds: ALLOWED,
      selfHandle: "+bot",
      resolveParticipants: (chatId) => roster[chatId] ?? [],
    });
    expect(await port.getParticipants("iMessage;+;chat123")).toEqual(["+1001", "+1002"]);
    expect(await port.getParticipants("iMessage;+;unknown")).toEqual([]);
  });

  it("returns an empty roster when participant lookup is disabled", async () => {
    const port = new PhotonChatPort({ sdk: new FakeSdk(), allowedChatIds: ALLOWED, resolveParticipants: null });
    expect(await port.getParticipants("iMessage;+;chat123")).toEqual([]);
  });
});

describe("PhotonChatPort direct messages", () => {
  it("routes a 1-on-1 (dm) message to onDirectMessage, not onMessage", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const group: IncomingMessage[] = [];
    const direct: IncomingMessage[] = [];
    port.onMessage((m) => group.push(m));
    port.onDirectMessage((m) => direct.push(m));

    // A dm from a chat NOT in the allowlist still reaches the DM handler (it's addressed to the bot).
    sdk.emit(makeMessage({ chatId: "iMessage;+;dmX", chatKind: "dm", text: "what's my balance?" }));

    expect(group).toHaveLength(0);
    expect(direct.map((m) => m.text)).toEqual(["what's my balance?"]);
  });

  it("does not treat a group message as a dm", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: ALLOWED });
    const direct: IncomingMessage[] = [];
    port.onDirectMessage((m) => direct.push(m));
    sdk.emit(makeMessage({ text: "group chatter" })); // chatKind defaults to "group"
    expect(direct).toHaveLength(0);
  });
});

describe("PhotonChatPort getChatName", () => {
  it("returns the chat's display name, or null when there is none or lookup is off", async () => {
    const named = new PhotonChatPort({
      sdk: new FakeSdk(),
      allowedChatIds: ALLOWED,
      resolveChatName: (id) => (id === "iMessage;+;chat123" ? "Cabo Trip" : null),
    });
    expect(await named.getChatName("iMessage;+;chat123")).toBe("Cabo Trip");
    expect(await named.getChatName("iMessage;+;other")).toBeNull();

    const off = new PhotonChatPort({ sdk: new FakeSdk(), allowedChatIds: ALLOWED, resolveChatName: null });
    expect(await off.getChatName("iMessage;+;chat123")).toBeNull();
  });
});

describe("PhotonChatPort auto-serve", () => {
  it("serves every group chat it's in when no allowlist is set", async () => {
    const sdk = new FakeSdk();
    sdk.chats = [makeChat({ chatId: "iMessage;+;chatAUTO" }), makeChat({ chatId: "iMessage;+;dm1", kind: "dm" })];
    const port = new PhotonChatPort({ sdk, allowedChatIds: [], log: () => undefined });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));
    await port.start();

    sdk.emit(makeMessage({ chatId: "iMessage;+;chatAUTO", text: "hi all" }));
    expect(received.map((m) => m.text)).toEqual(["hi all"]);
  });

  it("discovers a group added after startup, then serves it", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: [], log: () => undefined });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));
    await port.start(); // no chats yet

    sdk.chats = [makeChat({ chatId: "iMessage;+;chatLATE" })];
    sdk.emit(makeMessage({ chatId: "iMessage;+;chatLATE", text: "just added" }));
    expect(received).toHaveLength(0); // discovery is async
    await flush();
    expect(received.map((m) => m.text)).toEqual(["just added"]);
  });

  it("ignores a chat it's not in and stops re-checking it", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, allowedChatIds: [], log: () => undefined });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));
    await port.start();

    sdk.emit(makeMessage({ chatId: "iMessage;+;dmX", text: "spam" }));
    await flush();
    expect(received).toHaveLength(0);
    const calls = sdk.listChatsCalls;
    sdk.emit(makeMessage({ chatId: "iMessage;+;dmX", text: "spam again" }));
    await flush();
    expect(sdk.listChatsCalls).toBe(calls); // cached as not-served, no second lookup
  });

  it("with an explicit allowlist, never auto-discovers", async () => {
    const sdk = new FakeSdk();
    sdk.chats = [makeChat({ chatId: "iMessage;+;chatAUTO" })];
    const port = new PhotonChatPort({ sdk, allowedChatIds: ["iMessage;+;chat123"], log: () => undefined });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));
    await port.start();

    sdk.emit(makeMessage({ chatId: "iMessage;+;chatAUTO", text: "not allowlisted" }));
    await flush();
    expect(received).toHaveLength(0);
    expect(sdk.listChatsCalls).toBe(0); // no discovery in explicit mode
  });
});
