import { describe, expect, it } from "vitest";
import type {
  Attachment,
  DispatchEvents,
  Message,
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

  async send(request: SendRequest): Promise<void> {
    this.sends.push(request);
  }
  async startWatching(events?: DispatchEvents): Promise<void> {
    this.startWatchingCalls += 1;
    this.watchEvents = events;
  }
  async stopWatching(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }

  /** Simulate the watcher observing an inbound row. */
  emit(message: Message): void {
    this.watchEvents?.onIncomingMessage?.(message);
  }
}

// ----------------------------------------------------------------------------
// Row factories: full, strict-typed Message/Reaction/Attachment with overrides.
// ----------------------------------------------------------------------------

const AT = new Date("2026-01-02T03:04:05.000Z");

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

  it("defaults null text/participant and drops attachments with no local file", () => {
    const row = makeMessage({
      text: null,
      participant: null,
      attachments: [makeAttachment({ localPath: null })],
    });
    const mapped = mapMessageRow(row);
    expect(mapped?.text).toBe("");
    expect(mapped?.senderHandle).toBe("");
    expect(mapped?.attachments).toEqual([]);
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
    const port = new PhotonChatPort({ sdk, sentIdTimeoutMs: 10 });
    const ref = await port.postMessage("iMessage;+;chatABC", "hello group");
    expect(sdk.sends).toEqual([{ to: "iMessage;+;chatABC", text: "hello group" }]);
    expect(ref.chatId).toBe("iMessage;+;chatABC");
    expect(ref.id).toMatch(/^local:/);
  });

  it("postMessage returns the real chat.db id once the sent row shows up", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk, sentIdTimeoutMs: 1000 });
    const pending = port.postMessage("iMessage;+;chatABC", "🧾 #1 Dinner");
    await Promise.resolve();
    // Another of my messages in a different chat doesn't match; the right one does.
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "other", chatId: "iMessage;+;elsewhere", text: "🧾 #1 Dinner", isFromMe: true }));
    sdk.watchEvents?.onFromMeMessage?.(makeMessage({ id: "card-guid", chatId: "iMessage;+;chatABC", text: "🧾 #1 Dinner", isFromMe: true }));
    expect(await pending).toEqual({ id: "card-guid", chatId: "iMessage;+;chatABC" });
  });

  it("postImage sends the local file path as an attachment with an optional caption", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
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

  it("sendDirectMessage sends to a bare handle", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
    const ref = await port.sendDirectMessage("+15559990000", "your share is $12");
    expect(sdk.sends).toEqual([{ to: "+15559990000", text: "your share is $12" }]);
    expect(ref.chatId).toBe("+15559990000");
  });
});

describe("PhotonChatPort watcher", () => {
  it("delivers incoming messages to onMessage handlers", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    sdk.emit(makeMessage({ text: "buy milk" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("buy milk");
  });

  it("routes a 👍 reaction to onReaction and NOT to onMessage", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
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
    const port = new PhotonChatPort({ sdk });
    port.onMessage(() => {});
    port.onReaction(() => {});
    expect(sdk.startWatchingCalls).toBe(1);
  });

  it("unsubscribe stops delivering to a handler", () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
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
    const port = new PhotonChatPort({ sdk, onError: (e) => errors.push(e) });
    port.onMessage(() => {});

    const boom = new Error("db locked");
    sdk.watchEvents?.onError?.(boom);

    expect(errors).toEqual([boom]);
  });

  it("close releases the SDK", async () => {
    const sdk = new FakeSdk();
    const port = new PhotonChatPort({ sdk });
    port.onMessage(() => {});
    await port.close();
    expect(sdk.closed).toBe(true);
  });
});
