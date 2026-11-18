/**
 * @gta/imessage — the core `ChatPort` on iMessage, via Photon's `spectrum-ts`.
 *
 * Local mode (default, free, supports group chats) runs through Messages.app on a Mac, as whatever
 * Apple ID is signed in there. The terminal running it needs Full Disk Access. Cloud mode uses a
 * Photon Stable cloud line; on the free tier those lines don't support group chats or tapbacks.
 *
 * Tested in a real group chat (local mode): receiving text with the sender's number, receiving a
 * photo, and replying into the group. Not yet confirmed: what a 👍 tapback arrives as, voice memos.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localIMessage } from "@spectrum-ts/imessage-local";
import type {
  ChatPort,
  ImageRef,
  IncomingMessage,
  IncomingReaction,
  MessageRef,
  Unsubscribe,
} from "@gta/core";
import { attachment, Spectrum, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/** A message containing this word reveals its chat id in the logs, so it can be allowlisted. */
const CLAIM_WORD = "#treasury";

export interface PhotonChatPortConfig {
  mode?: "local" | "cloud";
  /** The port ignores every chat not listed here. Required: in local mode it can see all chats. */
  allowedChatIds: string[];
  /** Folder for downloaded photos (ImageRef.uri points here). Defaults to a temp folder. */
  mediaDir?: string;
  log?: (line: string) => void;
}

export class PhotonChatPort implements ChatPort {
  private readonly allowed: Set<string>;
  private readonly spaces = new Map<string, Space>();
  private readonly messageHandlers = new Set<(msg: IncomingMessage) => void>();
  private readonly reactionHandlers = new Set<(reaction: IncomingReaction) => void>();
  private readonly log: (line: string) => void;

  constructor(private readonly config: PhotonChatPortConfig) {
    this.allowed = new Set(config.allowedChatIds);
    this.log = config.log ?? ((line) => console.log(`[imessage] ${line}`));
  }

  /** Connects to Messages (or the cloud line) and delivers events until the process exits. */
  async start(): Promise<void> {
    const mode = this.config.mode ?? "local";
    if (mode === "local") {
      // Spectrum contacts Photon's cloud at startup whenever these are set, even for local only.
      delete process.env.SPECTRUM_PROJECT_ID;
      delete process.env.SPECTRUM_PROJECT_SECRET;
    }
    const mediaDir = this.config.mediaDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "gta-media-")));
    await fs.mkdir(mediaDir, { recursive: true });

    const app = await Spectrum({
      providers: [mode === "cloud" ? imessage.config() : localIMessage.config()],
    });
    this.log(`connected (${mode}), ${this.allowed.size} chat(s) allowlisted`);

    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      const content = message.content;

      if (!this.allowed.has(space.id)) {
        // Never log other chats' text. The claim word only reveals the chat id.
        if (content.type === "text" && content.text.toLowerCase().includes(CLAIM_WORD)) {
          this.log(`claim: add ${space.id} to the allowlist`);
        }
        continue;
      }
      // Messages from the signed-in Apple ID (including our own replies) can arrive with no sender.
      const sender = message.sender?.id;
      if (!sender) continue;
      this.spaces.set(space.id, space);
      const at = Date.now();

      try {
        if (content.type === "text") {
          this.emitMessage({ chatId: space.id, senderHandle: sender, text: content.text, attachments: [], at });
        } else if (content.type === "attachment" && content.mimeType.startsWith("image/")) {
          const file = path.join(mediaDir, `${message.id.replace(/[^\w-]/g, "_")}-${content.name}`);
          await fs.writeFile(file, await content.read());
          this.emitMessage({
            chatId: space.id,
            senderHandle: sender,
            text: "",
            attachments: [{ uri: file, mimeType: content.mimeType }],
            at,
          });
        } else if (content.type === "reaction") {
          this.log(`reaction ${JSON.stringify(content.emoji)} on ${content.target.id}`);
          for (const handler of this.reactionHandlers) {
            handler({
              chatId: space.id,
              senderHandle: sender,
              targetMessageId: content.target.id,
              emoji: content.emoji,
              added: true,
              at,
            });
          }
        }
      } catch (err) {
        this.log(`failed on ${content.type} from ${sender}: ${(err as Error).message}`);
      }
    }
  }

  private emitMessage(msg: IncomingMessage): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  private space(chatId: string): Space {
    const space = this.spaces.get(chatId);
    if (!space) throw new Error(`Chat ${chatId} hasn't sent anything yet, so it can't be replied to`);
    return space;
  }

  async postMessage(chatId: string, text: string): Promise<MessageRef> {
    const sent = await this.space(chatId).send(text);
    return { id: sent?.id ?? "", chatId };
  }

  async postImage(chatId: string, image: ImageRef, caption?: string): Promise<MessageRef> {
    const space = this.space(chatId);
    const sent = await space.send(attachment(image.uri, image.mimeType ? { mimeType: image.mimeType } : {}));
    if (caption) await space.send(caption);
    return { id: sent?.id ?? "", chatId };
  }

  async sendDirectMessage(_handle: string, _text: string): Promise<MessageRef> {
    throw new Error("Direct messages aren't supported by the iMessage adapter yet");
  }

  onMessage(handler: (msg: IncomingMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onReaction(handler: (reaction: IncomingReaction) => void): Unsubscribe {
    this.reactionHandlers.add(handler);
    return () => this.reactionHandlers.delete(handler);
  }
}
