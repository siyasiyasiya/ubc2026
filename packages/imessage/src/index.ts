/**
 * @gta/imessage — the core `ChatPort` on iMessage, via Photon's `spectrum-ts`.
 *
 * Base adapter (send text, receive text/photo, reply into a group) is Neena's,
 * tested live in a real group chat in local mode. This version adds correct 👍
 * tapback handling on top — see `mapReaction` below.
 *
 * Local mode (default, free, supports group chats) runs through Messages.app on a Mac, as whatever
 * Apple ID is signed in there. The terminal running it needs Full Disk Access. Cloud mode uses a
 * Photon Stable cloud line; on the free tier those lines don't support group chats or tapbacks.
 *
 * REACTIONS / TAPBACKS (grounded in spectrum-ts's official `Message` reference + live testing):
 *   - An inbound 👍 "like" tapback arrives as a message whose `content` is
 *     `{ type: "reaction", emoji: "👍", target: Message }`, and the person who reacted is the
 *     message's own `sender` — the SAME field a text message uses. `mapReaction` attributes it by
 *     `message.sender`, so per-member "everyone 👍s to approve" works.
 *   - There is no add/remove flag on the content: an inbound reaction is always an ADD. A tapback
 *     *removal* is an `unsend` of the reaction message, which this SDK version does not surface as a
 *     distinct attributable event — so `mapReaction` is parameterised on `added` for the day it does,
 *     but the live loop only emits adds today.
 *   - `sender` can be transiently undefined until the group chat's participants are registered/
 *     resolved (a setup artifact, not a design limit); we skip those rows rather than mis-attribute.
 *   - TODO(verify-on-mac): confirm inbound-tapback delivery against a live device/line — this is the
 *     one spot to re-check on a real Mac.
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
import { attachment, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/** The emoji the group-treasury flow treats as an "approve". `Emoji.like` in spectrum-ts. */
const THUMBS_UP = "👍";

/** A message containing this word reveals its chat id in the logs, so it can be allowlisted. */
const CLAIM_WORD = "#treasury";

// ----------------------------------------------------------------------------
// Structural view of the spectrum-ts surface this adapter uses. Declared as thin
// interfaces (not the full `SpectrumInstance`/`Space`, which are huge) so tests
// can inject a fully-typed fake. The real app is adapted to this view by a single
// localized cast at the SDK boundary in `defaultApp` — the only `as` in the file.
// ----------------------------------------------------------------------------

/** A chat we can reply into. Real spectrum-ts `Space` satisfies this. */
export interface ReplyTarget {
  readonly id: string;
  send(content: unknown): Promise<{ readonly id: string } | undefined>;
}

/**
 * The inbound content shapes we read. Real spectrum-ts `Content` is a superset (voice, markdown,
 * group, etc.); the boundary cast in `defaultApp` bridges the two, and any runtime content type not
 * listed here simply matches none of the branches in `handle` and is ignored.
 */
export type InboundContent =
  | { type: "text"; text: string }
  | { type: "attachment"; mimeType: string; name: string; read(): Promise<Uint8Array> }
  | { type: "reaction"; emoji: string; target: { readonly id: string } };

export interface InboundMessage {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly sender?: { readonly id: string } | null;
  readonly content: InboundContent;
}

/** The subset of a Spectrum app this adapter drives: a stream of [space, message]. */
export interface InboundApp {
  readonly messages: AsyncIterable<readonly [ReplyTarget, InboundMessage]>;
}

export interface PhotonChatPortConfig {
  mode?: "local" | "cloud";
  /** The port ignores every chat not listed here. Required: in local mode it can see all chats. */
  allowedChatIds: string[];
  /** Folder for downloaded photos (ImageRef.uri points here). Defaults to a temp folder. */
  mediaDir?: string;
  log?: (line: string) => void;
  /**
   * Inject a pre-built app (or a fake in tests). When provided, `mode` is ignored for connecting.
   * Defaults to a real `Spectrum(...)` instance.
   */
  app?: InboundApp;
}

/**
 * ISOLATED REACTION MAPPING — the ONE place to correct when Photon's reaction surface changes.
 *
 * Maps a spectrum-ts `reaction` content to a core `IncomingReaction`, or returns `null` when the
 * reaction is not the 👍 "like" tapback we treat as an approval (love/laugh/dislike/emphasize/
 * question tapbacks and arbitrary emoji reactions are all ignored).
 *
 * `added` is supplied by the caller: `true` for an inbound reaction event (the only thing the
 * stream yields today), `false` for a removal once this SDK version surfaces removals as
 * attributable events (see the file header). Keeping it a parameter means the add→remove change is
 * a one-liner at the call site, not a change to this mapping.
 */
export function mapReaction(
  chatId: string,
  senderHandle: string,
  content: { emoji: string; target: { readonly id: string } },
  added: boolean,
  at: number,
): IncomingReaction | null {
  if (content.emoji !== THUMBS_UP) return null;
  return {
    chatId,
    senderHandle,
    targetMessageId: content.target.id,
    emoji: THUMBS_UP,
    added,
    at,
  };
}

/** Build the real Spectrum app for the given mode. Isolated so tests never touch it. */
async function defaultApp(mode: "local" | "cloud"): Promise<InboundApp> {
  if (mode === "local") {
    // Spectrum contacts Photon's cloud at startup whenever these are set, even for local only.
    delete process.env.SPECTRUM_PROJECT_ID;
    delete process.env.SPECTRUM_PROJECT_SECRET;
  }
  const real = await Spectrum({
    providers: [mode === "cloud" ? imessage.config() : localIMessage.config()],
  });
  // Single, localized adaptation at the SDK boundary: we only use `.messages` and `space.send`,
  // both of which the real `SpectrumInstance`/`Space` provide. See `InboundApp` above.
  return real as unknown as InboundApp;
}

export class PhotonChatPort implements ChatPort {
  private readonly allowed: Set<string>;
  private readonly spaces = new Map<string, ReplyTarget>();
  private readonly messageHandlers = new Set<(msg: IncomingMessage) => void>();
  private readonly reactionHandlers = new Set<(reaction: IncomingReaction) => void>();
  private readonly log: (line: string) => void;

  constructor(private readonly config: PhotonChatPortConfig) {
    this.allowed = new Set(config.allowedChatIds);
    this.log = config.log ?? ((line) => console.log(`[imessage] ${line}`));
  }

  /** Connects to Messages (or the cloud line) and delivers events until the stream ends. */
  async start(): Promise<void> {
    const mode = this.config.mode ?? "local";
    const mediaDir = this.config.mediaDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "gta-media-")));
    await fs.mkdir(mediaDir, { recursive: true });

    const app = this.config.app ?? (await defaultApp(mode));
    this.log(`connected (${this.config.app ? "injected" : mode}), ${this.allowed.size} chat(s) allowlisted`);

    for await (const [space, message] of app.messages) {
      await this.handle(space, message, mediaDir);
    }
  }

  /** Route one inbound [space, message] to the message or reaction handlers. */
  private async handle(space: ReplyTarget, message: InboundMessage, mediaDir: string): Promise<void> {
    if (message.direction === "outbound") return;
    const content = message.content;

    if (!this.allowed.has(space.id)) {
      // Never log other chats' text. The claim word only reveals the chat id.
      if (content.type === "text" && content.text.toLowerCase().includes(CLAIM_WORD)) {
        this.log(`claim: add ${space.id} to the allowlist`);
      }
      return;
    }
    // Messages from the signed-in Apple ID (including our own replies) can arrive with no sender.
    const sender = message.sender?.id;
    if (!sender) return;
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
        // Inbound reaction events are ADDs (see file header); removals are unsends and are not
        // surfaced as attributable events in this SDK version, so we pass `added: true`.
        const reaction = mapReaction(space.id, sender, content, true, at);
        if (reaction) {
          this.log(`👍 approve on ${content.target.id} from ${sender}`);
          this.emitReaction(reaction);
        }
      }
    } catch (err) {
      this.log(`failed on ${content.type} from ${sender}: ${(err as Error).message}`);
    }
  }

  private emitMessage(msg: IncomingMessage): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  private emitReaction(reaction: IncomingReaction): void {
    for (const handler of this.reactionHandlers) handler(reaction);
  }

  private space(chatId: string): ReplyTarget {
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
