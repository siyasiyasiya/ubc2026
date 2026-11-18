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
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

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
  /**
   * Looks up who sent a message by its id when the SDK leaves `participant` null, which it does
   * for reactions in group chats. Defaults to a read-only chat.db lookup when the real SDK is used;
   * pass `null` to disable.
   */
  resolveSender?: SenderResolver | null;
  /** How long postMessage waits for the sent row to appear in chat.db to learn its id. */
  sentIdTimeoutMs?: number;
}

/** Returns the sender's handle for a message id, or null if unknown. */
export type SenderResolver = (messageId: string) => string | null;

/** Reaction targets look like "p:0/<guid>"; message ids are the bare guid. */
export function normalizeMessageId(id: string): string {
  return id.replace(/^p:\d+\//, "");
}

/** Read-only chat.db lookup of a message's sender handle (needs Full Disk Access). */
export function chatDbSenderResolver(databasePath?: string): SenderResolver {
  let db: Database.Database | undefined;
  let stmt: Database.Statement<[string], { handle: string }> | undefined;
  return (messageId) => {
    try {
      db ??= new Database(databasePath ?? path.join(os.homedir(), "Library/Messages/chat.db"), {
        readonly: true,
        fileMustExist: true,
      });
      stmt ??= db.prepare(
        "SELECT h.id AS handle FROM message m JOIN handle h ON h.ROWID = m.handle_id WHERE m.guid = ?",
      );
      return stmt.get(messageId)?.handle ?? null;
    } catch {
      return null;
    }
  };
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
export function mapReactionRow(
  message: Message,
  resolveSender?: SenderResolver,
): IncomingReaction | null {
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
  // Need the conversation + the handle that reacted to route/attribute it. Group reactions
  // arrive with participant null, so fall back to the chat.db lookup.
  if (message.chatId === null || message.isFromMe) return null;
  const sender = message.participant ?? resolveSender?.(message.id) ?? null;
  if (sender === null) return null;

  return {
    chatId: message.chatId,
    senderHandle: sender,
    targetMessageId: normalizeMessageId(reaction.targetMessageId),
    emoji: THUMBS_UP,
    added: !reaction.isRemoved,
    at: message.createdAt.getTime(),
  };
}

/**
 * Map a watcher `Message` row to a core `IncomingMessage`, or `null` when the
 * row cannot be routed (missing chat) or is actually a reaction row.
 */
export function mapMessageRow(
  message: Message,
  resolveSender?: SenderResolver,
): IncomingMessage | null {
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
    senderHandle: message.participant ?? resolveSender?.(message.id) ?? "",
    text: message.text ?? "",
    attachments,
    at: message.createdAt.getTime(),
  };
}

/** Real ChatPort over imessage-kit. */
export class PhotonChatPort implements ChatPort {
  private readonly sdk: PhotonSdk;
  private readonly onError: (error: Error) => void;
  private readonly resolveSender: SenderResolver | undefined;
  private readonly sentIdTimeoutMs: number;
  /** Sends waiting to learn their chat.db id from the watcher's from-me rows. */
  private readonly pendingSends: { chatId: string; text: string; resolve: (id: string) => void }[] = [];

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly reactionHandlers = new Set<ReactionHandler>();
  /** Guards against a second `startWatching` (the SDK rejects a second watcher). */
  private watchStarting = false;
  private watching = false;

  constructor(config: PhotonChatPortConfig = {}) {
    this.sdk = config.sdk ?? new IMessageSDK(config.sdkConfig);
    this.resolveSender =
      config.resolveSender === null
        ? undefined
        : (config.resolveSender ??
          (config.sdk ? undefined : chatDbSenderResolver(config.sdkConfig?.databasePath)));
    this.sentIdTimeoutMs = config.sentIdTimeoutMs ?? 10_000;
    this.onError =
      config.onError ??
      ((error) => {
        // eslint-disable-next-line no-console
        console.error("[@gta/imessage] watcher error:", error);
      });
  }

  async postMessage(chatId: string, text: string): Promise<MessageRef> {
    // Start listening before sending so a fast chat.db row isn't missed.
    const sentId = this.awaitSentId(chatId, text);
    this.ensureWatching();
    await this.sdk.send({ to: chatId, text });
    const id = await sentId;
    return id ? { id, chatId } : this.makeRef(chatId);
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
   * Fallback when the sent row's guid wasn't seen in time (see `awaitSentId`). A 👍 on such a
   * message can't be matched to it.
   */
  private makeRef(chatId: string): MessageRef {
    return { id: `local:${randomUUID()}`, chatId };
  }

  /**
   * `send()` resolves on AppleScript dispatch and never returns the chat.db guid. The watcher's
   * from-me rows do carry it, so wait for the next from-me row in this chat with the same text.
   * Resolves undefined after `sentIdTimeoutMs`.
   */
  private awaitSentId(chatId: string, text: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const entry = { chatId, text, resolve: (id: string) => resolve(id) };
      this.pendingSends.push(entry);
      setTimeout(() => {
        const i = this.pendingSends.indexOf(entry);
        if (i >= 0) {
          this.pendingSends.splice(i, 1);
          resolve(undefined);
        }
      }, this.sentIdTimeoutMs).unref?.();
    });
  }

  private matchSent(message: Message): void {
    if (message.reaction || message.text === null) return;
    const i = this.pendingSends.findIndex(
      (p) => p.text === message.text && (message.chatId === null || p.chatId === message.chatId),
    );
    if (i < 0) return;
    const [entry] = this.pendingSends.splice(i, 1);
    entry?.resolve(message.id);
  }

  /** Start the single shared watcher on first subscription (idempotent). */
  private ensureWatching(): void {
    if (this.watching || this.watchStarting) return;
    this.watchStarting = true;
    this.sdk
      .startWatching({
        onIncomingMessage: (message) => this.dispatch(message),
        onFromMeMessage: (message) => this.matchSent(message),
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
      const reaction = mapReactionRow(message, this.resolveSender);
      if (reaction) {
        for (const handler of this.reactionHandlers) handler(reaction);
      }
      return; // reaction rows are not messages
    }
    const msg = mapMessageRow(message, this.resolveSender);
    if (!msg) return;
    for (const handler of this.messageHandlers) handler(msg);
  }
}
