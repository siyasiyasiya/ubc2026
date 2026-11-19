import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { IncomingMessage, IncomingReaction } from "@gta/core";

import {
  PhotonChatPort,
  mapReaction,
  type InboundApp,
  type InboundMessage,
  type ReplyTarget,
} from "./index.js";

// ----------------------------------------------------------------------------
// Fakes: a Spectrum app + spaces that record sends and replay a scripted inbound
// stream. The adapter runs its real `start()` loop and real send methods against
// these injected doubles — nothing in the adapter under test is stubbed out.
// ----------------------------------------------------------------------------

class FakeSpace implements ReplyTarget {
  readonly sends: unknown[] = [];
  constructor(public readonly id: string) {}
  async send(content: unknown): Promise<{ readonly id: string }> {
    this.sends.push(content);
    return { id: `sent-${this.sends.length}` };
  }
}

class FakeApp implements InboundApp {
  constructor(private readonly events: Array<readonly [ReplyTarget, InboundMessage]>) {}
  get messages(): AsyncIterable<readonly [ReplyTarget, InboundMessage]> {
    const events = this.events;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    };
  }
}

const CHAT = "iMessage;+;chat123";

function textMsg(over: Partial<InboundMessage> = {}, text = "we are out of paper towels"): InboundMessage {
  return {
    id: "msg-1",
    direction: "inbound",
    sender: { id: "+15551230000" },
    content: { type: "text", text },
    ...over,
  };
}

function reactionMsg(emoji: string, targetId = "target-guid-1", over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "msg-reaction-1",
    direction: "inbound",
    sender: { id: "+15551230000" },
    content: { type: "reaction", emoji, target: { id: targetId } },
    ...over,
  };
}

// A temp media dir shared by image tests, cleaned up at the end.
let mediaDir: string;
async function getMediaDir(): Promise<string> {
  mediaDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "gta-imessage-test-"));
  return mediaDir;
}
afterAll(async () => {
  if (mediaDir) await fs.rm(mediaDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// mapReaction — the isolated 👍 mapping (add + remove)
// ----------------------------------------------------------------------------

describe("mapReaction", () => {
  const target = { id: "target-guid-1" };

  it("maps a 👍 add to IncomingReaction (added=true)", () => {
    expect(mapReaction(CHAT, "+15551230000", { emoji: "👍", target }, true, 1234)).toEqual<IncomingReaction>({
      chatId: CHAT,
      senderHandle: "+15551230000",
      targetMessageId: "target-guid-1",
      emoji: "👍",
      added: true,
      at: 1234,
    });
  });

  it("maps a 👍 removal to added=false", () => {
    const mapped = mapReaction(CHAT, "+15551230000", { emoji: "👍", target }, false, 1234);
    expect(mapped?.emoji).toBe("👍");
    expect(mapped?.added).toBe(false);
  });

  it("ignores non-👍 tapbacks / emoji reactions", () => {
    for (const emoji of ["❤️", "👎", "😂", "‼️", "❓", "🎉"]) {
      expect(mapReaction(CHAT, "+15551230000", { emoji, target }, true, 1234)).toBeNull();
    }
  });
});

// ----------------------------------------------------------------------------
// PhotonChatPort — real adapter driven by the injected fake app
// ----------------------------------------------------------------------------

describe("PhotonChatPort receive", () => {
  it("delivers an allowlisted text message to onMessage handlers", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, textMsg({}, "buy milk")]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ chatId: CHAT, senderHandle: "+15551230000", text: "buy milk", attachments: [] });
  });

  it("downloads an image attachment and emits it as an ImageRef", async () => {
    const dir = await getMediaDir();
    const bytes = new TextEncoder().encode("PNGDATA");
    const space = new FakeSpace(CHAT);
    const img: InboundMessage = {
      id: "msg-img-1",
      direction: "inbound",
      sender: { id: "+15551230000" },
      content: { type: "attachment", mimeType: "image/png", name: "cart.png", read: async () => bytes },
    };
    const app = new FakeApp([[space, img]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, mediaDir: dir, log: () => {} });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start();

    expect(received).toHaveLength(1);
    const att = received[0]?.attachments[0];
    expect(att?.mimeType).toBe("image/png");
    expect(att?.uri.startsWith(dir)).toBe(true);
    await expect(fs.readFile(att!.uri, "utf8")).resolves.toBe("PNGDATA");
  });

  it("ignores messages from chats not on the allowlist", async () => {
    const space = new FakeSpace("iMessage;+;other");
    const app = new FakeApp([[space, textMsg({}, "secret stuff")]]);
    const logs: string[] = [];
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: (l) => logs.push(l) });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start();

    expect(received).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("logs a claim (chat id only) for #treasury in a non-allowlisted chat", async () => {
    const space = new FakeSpace("iMessage;+;other");
    const app = new FakeApp([[space, textMsg({}, "hello #treasury please")]]);
    const logs: string[] = [];
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: (l) => logs.push(l) });
    port.onMessage(() => {});

    await port.start();

    expect(logs.some((l) => l.includes("claim") && l.includes("iMessage;+;other"))).toBe(true);
  });

  it("drops a message with no sender (our own reply echoed back)", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, textMsg({ sender: null }, "echo")]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    const received: IncomingMessage[] = [];
    port.onMessage((m) => received.push(m));

    await port.start();
    expect(received).toHaveLength(0);
  });
});

describe("PhotonChatPort reactions", () => {
  it("routes a 👍 reaction to onReaction and NOT to onMessage", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, reactionMsg("👍", "target-guid-1")]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    const messages: IncomingMessage[] = [];
    const reactions: IncomingReaction[] = [];
    port.onMessage((m) => messages.push(m));
    port.onReaction((r) => reactions.push(r));

    await port.start();

    expect(messages).toHaveLength(0);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({
      chatId: CHAT,
      senderHandle: "+15551230000",
      targetMessageId: "target-guid-1",
      emoji: "👍",
      added: true,
    });
  });

  it("ignores a non-👍 tapback on the live stream", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, reactionMsg("😂")]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    const reactions: IncomingReaction[] = [];
    port.onReaction((r) => reactions.push(r));

    await port.start();
    expect(reactions).toHaveLength(0);
  });
});

describe("PhotonChatPort send", () => {
  it("postMessage sends text into a known space and returns a ref", async () => {
    const space = new FakeSpace(CHAT);
    // One inbound message registers the space so it can be replied to.
    const app = new FakeApp([[space, textMsg()]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    port.onMessage(() => {});
    await port.start();

    const ref = await port.postMessage(CHAT, "hello group");
    expect(space.sends).toEqual(["hello group"]);
    expect(ref).toEqual({ id: "sent-1", chatId: CHAT });
  });

  it("postImage sends an attachment then the caption", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, textMsg()]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    port.onMessage(() => {});
    await port.start();

    await port.postImage(CHAT, { uri: "/tmp/cart.png", mimeType: "image/png" }, "Approve this cart?");
    // First send is the attachment builder (an object), second is the caption string.
    expect(space.sends).toHaveLength(2);
    expect(typeof space.sends[0]).toBe("object");
    expect(space.sends[1]).toBe("Approve this cart?");
  });

  it("postMessage throws for an unknown chat", async () => {
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app: new FakeApp([]), log: () => {} });
    await expect(port.postMessage(CHAT, "hi")).rejects.toThrow(/hasn't sent anything/);
  });

  it("opens an allowlisted chat by id when nobody has written there since startup", async () => {
    const space = new FakeSpace(CHAT);
    const opened: string[] = [];
    const app: InboundApp = {
      messages: new FakeApp([]).messages,
      openSpace: async (id) => (opened.push(id), space),
    };
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    await port.start();

    await port.postMessage(CHAT, "✅ Siya is in.");
    await port.postMessage(CHAT, "again");
    expect(space.sends).toEqual(["✅ Siya is in.", "again"]);
    expect(opened).toEqual([CHAT]); // opened once, then cached
    await expect(port.postMessage("iMessage;+;other", "hi")).rejects.toThrow(/isn't allowlisted/);
  });

  it("sendDirectMessage is not supported yet", async () => {
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app: new FakeApp([]), log: () => {} });
    await expect(port.sendDirectMessage("+15559990000", "hi")).rejects.toThrow(/aren't supported/i);
  });
});

describe("PhotonChatPort unsubscribe", () => {
  it("stops delivering after unsubscribe", async () => {
    const space = new FakeSpace(CHAT);
    const app = new FakeApp([[space, textMsg({}, "first")]]);
    const port = new PhotonChatPort({ allowedChatIds: [CHAT], app, log: () => {} });
    const received: IncomingMessage[] = [];
    const unsubscribe = port.onMessage((m) => received.push(m));
    unsubscribe();

    await port.start();
    expect(received).toHaveLength(0);
  });
});
