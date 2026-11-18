/**
 * @gta/imessage — Photon imessage-kit adapter (DECIDED chat provider).
 *
 * Real implementation of the core `ChatPort` against `@photon-ai/imessage-kit`
 * (self-hosted on a Mac with Full Disk Access + an iMessage account).
 *
 * The public SDK surface we build against (see its `.d.ts`):
 *   - `sdk.send({ to, text?, attachments? })` -> Promise<void>
 *         `to` is a chatId (groups) or a bare handle (DMs); `send()` resolves on
 *         AppleScript dispatch *acceptance*, not delivery, and returns no id.
 *   - `sdk.startWatching({ onIncomingMessage, onError })` -> Promise<void>
 *         fires `onIncomingMessage` for every inbound (non-from-me) row. A 👍
 *         tapback arrives as a `Message` whose `reaction` field is populated.
 *   - `sdk.stopWatching()` / `sdk.close()` for teardown.
 *
 * Only ONE watcher may run per SDK instance (`startWatching` throws `CONFIG`
 * otherwise), so this adapter starts a single watcher lazily and fans each row
 * out to the registered message/reaction handlers.
 */

import { randomUUID } from "node:crypto";

import type {
  ChatPort,
  ImageRef,
  IncomingMessage,
  IncomingReaction,
  MessageRef,
  Unsubscribe,
} from "@gta/core";
import {
  IMessageSDK,
  type DispatchEvents,
  type IMessageConfig,
  type Message,
  type Reaction,
  type SendRequest,
} from "@photon-ai/imessage-kit";

/**
 * Structural slice of `IMessageSDK` this adapter actually uses. Declared as an
 * interface (not the class) so tests can inject a fake, while the real
 * `IMessageSDK` still satisfies it — the adapter's method bodies issue the
 * genuine SDK calls either way.
 */
export interface PhotonSdk {
  send(request: SendRequest): Promise<void>;
  startWatching(events?: DispatchEvents): Promise<void>;
  stopWatching(): Promise<void>;
  close(): Promise<void>;
}

export interface PhotonChatPortConfig {
  /** Config forwarded to `new IMessageSDK(...)` (db path, concurrency, debug). */
  sdkConfig?: IMessageConfig;
  /**
   * Inject a pre-built SDK (or a fake in tests). When provided, `sdkConfig` is
   * ignored. Defaults to `new IMessageSDK(sdkConfig)`.
   */
  sdk?: PhotonSdk;
  /** Surfaces watcher/dispatch errors (ChatPort has no error channel). */
  onError?: (error: Error) => void;
}

type MessageHandler = (msg: IncomingMessage) => void;
type ReactionHandler = (reaction: IncomingReaction) => void;

/** The emoji the group-treasury flow treats as an "approve". */
const THUMBS_UP = "👍";

/**
 * Map a watcher `Message` row to a core `IncomingReaction`, or `null` when the
 * row is not a 👍 tapback we care about.
 *
 * GROUND TRUTH (imessage-kit v3 `Reaction`, from its `.d.ts`):
 *   - `message.reaction` is non-null only on reaction rows (tapback/sticker/poll).
 *   - `reaction.kind` is the normalized tapback. 'like' is the thumbs-up Tapback
 *     (`associated_message_type` 2001 add / 3001 remove). For classic Tapbacks
 *     `reaction.emoji` is `null`; only `kind: 'emoji'` rows carry an emoji string.
 *   - `reaction.targetMessageId` is the public guid of the message reacted to.
 *   - `reaction.isRemoved` is `true` when this row *removes* a prior reaction.
 *
 * This is the one spot to correct if the SDK's reaction shape changes in a
 * future version — keep the mapping isolated here.
 */
export function mapReactionRow(message: Message): IncomingReaction | null {
  const reaction: Reaction | null = message.reaction;
  if (!reaction) return null;

  // Thumbs-up = the classic 'like' Tapback, or a free-form emoji reaction whose
  // payload is literally the 👍 character.
  const isThumbsUp =
    reaction.kind === "like" ||
    (reaction.kind === "emoji" && reaction.emoji === THUMBS_UP);
  if (!isThumbsUp) return null;

  // Without a target we cannot attribute the approval to a posted message.
  if (reaction.targetMessageId === null) return null;
  // Need the conversation + the handle that reacted to route/attribute it.
  if (message.chatId === null || message.participant === null) return null;

  return {
    chatId: message.chatId,
    senderHandle: message.participant,
    targetMessageId: reaction.targetMessageId,
    emoji: THUMBS_UP,
    added: !reaction.isRemoved,
    at: message.createdAt.getTime(),
  };
}

/**
 * Map a watcher `Message` row to a core `IncomingMessage`, or `null` when the
 * row cannot be routed (missing chat) or is actually a reaction row.
 */
export function mapMessageRow(message: Message): IncomingMessage | null {
  // Reaction rows are never surfaced as plain messages.
  if (message.reaction) return null;
  if (message.chatId === null) return null;

  const attachments: ImageRef[] = [];
  for (const att of message.attachments) {
    // Consumers need a concrete local file; skip rows whose bytes are not yet
    // on disk (e.g. still transferring).
    if (att.localPath === null) continue;
    attachments.push({ uri: att.localPath, mimeType: att.mimeType });
  }

  return {
    chatId: message.chatId,
    senderHandle: message.participant ?? "",
    text: message.text ?? "",
    attachments,
    at: message.createdAt.getTime(),
  };
}

/** Real ChatPort over imessage-kit. */
export class PhotonChatPort implements ChatPort {
  private readonly sdk: PhotonSdk;
  private readonly onError: (error: Error) => void;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly reactionHandlers = new Set<ReactionHandler>();
  /** Guards against a second `startWatching` (the SDK rejects a second watcher). */
  private watchStarting = false;
  private watching = false;

  constructor(config: PhotonChatPortConfig = {}) {
    this.sdk = config.sdk ?? new IMessageSDK(config.sdkConfig);
    this.onError =
      config.onError ??
      ((error) => {
        // eslint-disable-next-line no-console
        console.error("[@gta/imessage] watcher error:", error);
      });
  }

  async postMessage(chatId: string, text: string): Promise<MessageRef> {
    await this.sdk.send({ to: chatId, text });
    return this.makeRef(chatId);
  }

  async postImage(chatId: string, image: ImageRef, caption?: string): Promise<MessageRef> {
    // imessage-kit sends local file paths; callers must localize remote URIs first.
    await this.sdk.send({ to: chatId, text: caption, attachments: [image.uri] });
    return this.makeRef(chatId);
  }

  async sendDirectMessage(handle: string, text: string): Promise<MessageRef> {
    // A bare handle (phone/email) routes to a 1-on-1 DM inside the SDK.
    await this.sdk.send({ to: handle, text });
    return this.makeRef(handle);
  }

  onMessage(handler: MessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    this.ensureWatching();
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onReaction(handler: ReactionHandler): Unsubscribe {
    this.reactionHandlers.add(handler);
    this.ensureWatching();
    return () => {
      this.reactionHandlers.delete(handler);
    };
  }

  /** Stop the watcher and release the SDK. Not part of ChatPort; call on shutdown. */
  async close(): Promise<void> {
    this.messageHandlers.clear();
    this.reactionHandlers.clear();
    await this.sdk.close();
    this.watching = false;
    this.watchStarting = false;
  }

  /**
   * `send()` resolves on AppleScript dispatch and never returns the chat.db
   * guid, so we mint a local ref. Correlating a posted message to the guid that
   * later reactions target requires observing `onFromMeMessage` on the watcher —
   * out of scope here and only observable on the Mac at runtime.
   */
  private makeRef(chatId: string): MessageRef {
    return { id: `local:${randomUUID()}`, chatId };
  }

  /** Start the single shared watcher on first subscription (idempotent). */
  private ensureWatching(): void {
    if (this.watching || this.watchStarting) return;
    this.watchStarting = true;
    this.sdk
      .startWatching({
        onIncomingMessage: (message) => this.dispatch(message),
        onError: (error) => this.onError(error),
      })
      .then(() => {
        this.watching = true;
      })
      .catch((error: unknown) => {
        this.watchStarting = false;
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /** Route one watcher row to reaction or message handlers (never both). */
  private dispatch(message: Message): void {
    if (message.reaction) {
      const reaction = mapReactionRow(message);
      if (reaction) {
        for (const handler of this.reactionHandlers) handler(reaction);
      }
      return; // reaction rows are not messages
    }
    const msg = mapMessageRow(message);
    if (!msg) return;
    for (const handler of this.messageHandlers) handler(msg);
  }
}
