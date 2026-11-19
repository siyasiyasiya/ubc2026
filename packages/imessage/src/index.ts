/**
 * @gta/imessage — the core `ChatPort` on iMessage, via Photon's `@photon-ai/imessage-kit`.
 *
 * Runs locally through Messages.app on a Mac, as whatever Apple ID is signed in. The process needs
 * Full Disk Access (it reads ~/Library/Messages/chat.db). We use imessage-kit directly rather than
 * `spectrum-ts` local mode because, live-tested on Nov 18:
 *   - spectrum-ts local mode (`@spectrum-ts/imessage-local` 12.16.0) drops every reaction row, so
 *     👍 tapbacks never reach the bot;
 *   - spectrum-ts `send()` returns a local id, not the chat.db guid that a later 👍 targets.
 * imessage-kit delivers reaction rows and reports our own sent rows (with their guids) through
 * `onFromMeMessage`, so a 👍 on the approval card can be matched to it.
 *
 * Also live-tested: group reaction rows arrive with `participant: null` even though chat.db knows
 * the sender (`message.handle_id`), so we fall back to a read-only chat.db lookup. Reaction targets
 * look like `p:0/<guid>`; we strip the prefix so they equal message ids.
 *
 * Safety: only allowlisted chats are surfaced. Other chats' text is never logged; a message
 * containing `#treasury` logs only that chat's id so it can be allowlisted.
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

/** The emoji the group-treasury flow treats as an "approve". */
const THUMBS_UP = "👍";

/** A message containing this word reveals its chat id in the logs, so it can be allowlisted. */
const CLAIM_WORD = "#treasury";

/** How many of our own recent sends to remember, so their echoes are never treated as input. */
const RECENT_SENDS = 50;

/**
 * Structural slice of `IMessageSDK` this adapter uses. An interface (not the class) so tests can
 * inject a fake; the real `IMessageSDK` satisfies it.
 */
export interface PhotonSdk {
  send(request: SendRequest): Promise<void>;
  startWatching(events?: DispatchEvents): Promise<void>;
  stopWatching(): Promise<void>;
  close(): Promise<void>;
}

/** Returns the sender's handle for a message id, or null if unknown. */
export type SenderResolver = (messageId: string) => string | null;

export interface PhotonChatPortConfig {
  /** The port ignores every chat not listed here. Required: it can see every chat on the Mac. */
  allowedChatIds: string[];
  /** Only "local" is supported (imessage-kit). Kept so callers can pass their configured mode. */
  mode?: "local" | "cloud";
  /** Config forwarded to `new IMessageSDK(...)` (db path, concurrency, debug). */
  sdkConfig?: IMessageConfig;
  /** Inject a pre-built SDK (or a fake in tests). Defaults to `new IMessageSDK(sdkConfig)`. */
  sdk?: PhotonSdk;
  /**
   * Who sent a message when the SDK leaves `participant` null (group reactions do). Defaults to a
   * read-only chat.db lookup when the real SDK is used; pass `null` to disable.
   */
  resolveSender?: SenderResolver | null;
  /**
   * While the bot runs on a member's own Apple ID, that member's messages and 👍s are "from me".
   * Set this to their handle to treat them as that member. The bot's own sends are still skipped.
   */
  selfHandle?: string;
  /** How long postMessage waits for the sent row to appear in chat.db to learn its id. */
  sentIdTimeoutMs?: number;
  log?: (line: string) => void;
  /** Surfaces watcher/dispatch errors (ChatPort has no error channel). */
  onError?: (error: Error) => void;
}

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

function senderOf(message: Message, resolveSender?: SenderResolver, selfHandle?: string): string | null {
  if (message.isFromMe) return selfHandle ?? null;
  return message.participant ?? resolveSender?.(message.id) ?? null;
}

/**
 * Map a watcher row to a core `IncomingReaction`, or `null` when it isn't a 👍 we can attribute.
 * A 👍 is the classic 'like' Tapback or an emoji reaction whose payload is literally 👍.
 */
export function mapReactionRow(
  message: Message,
  resolveSender?: SenderResolver,
  selfHandle?: string,
): IncomingReaction | null {
  const reaction: Reaction | null = message.reaction;
  if (!reaction) return null;
  const isThumbsUp =
    reaction.kind === "like" || (reaction.kind === "emoji" && reaction.emoji === THUMBS_UP);
  if (!isThumbsUp || reaction.targetMessageId === null || message.chatId === null) return null;
  const sender = senderOf(message, resolveSender, selfHandle);
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

/** Map a watcher row to a core `IncomingMessage`, or `null` (no chat, no sender, or a reaction). */
export function mapMessageRow(
  message: Message,
  resolveSender?: SenderResolver,
  selfHandle?: string,
): IncomingMessage | null {
  if (message.reaction || message.chatId === null) return null;
  const sender = senderOf(message, resolveSender, selfHandle);
  if (sender === null) return null;
  const attachments: ImageRef[] = [];
  for (const att of message.attachments) {
    // Consumers need a concrete local file; skip ones still transferring.
    if (att.localPath === null) continue;
    attachments.push({ uri: att.localPath, mimeType: att.mimeType });
  }
  return {
    chatId: message.chatId,
    senderHandle: sender,
    text: message.text ?? "",
    attachments,
    at: message.createdAt.getTime(),
  };
}

type MessageHandler = (msg: IncomingMessage) => void;
type ReactionHandler = (reaction: IncomingReaction) => void;

export class PhotonChatPort implements ChatPort {
  private readonly sdk: PhotonSdk;
  private readonly allowed: Set<string>;
  private readonly resolveSender: SenderResolver | undefined;
  private readonly selfHandle: string | undefined;
  private readonly sentIdTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly onError: (error: Error) => void;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly reactionHandlers = new Set<ReactionHandler>();
  /** Sends waiting to learn their chat.db id from the watcher's from-me rows. */
  private readonly pendingSends: { chatId: string; text: string; resolve: (id: string) => void }[] = [];
  /** Texts and guids of our own recent sends, so their echoes are never treated as input. */
  private readonly recentSendTexts: string[] = [];
  private readonly ourMessageIds = new Set<string>();
  private watchStarting: Promise<void> | undefined;

  constructor(config: PhotonChatPortConfig) {
    if (config.mode === "cloud") {
      throw new Error("@gta/imessage only supports local mode (imessage-kit on a Mac)");
    }
    this.sdk = config.sdk ?? new IMessageSDK(config.sdkConfig);
    this.allowed = new Set(config.allowedChatIds);
    this.resolveSender =
      config.resolveSender === null
        ? undefined
        : (config.resolveSender ??
          (config.sdk ? undefined : chatDbSenderResolver(config.sdkConfig?.databasePath)));
    this.selfHandle = config.selfHandle;
    this.sentIdTimeoutMs = config.sentIdTimeoutMs ?? 10_000;
    this.log = config.log ?? ((line) => console.log(`[imessage] ${line}`));
    this.onError = config.onError ?? ((error) => this.log(`watcher error: ${error.message}`));
  }

  /** Starts watching Messages. Resolves once the watcher is running; events keep arriving after. */
  async start(): Promise<void> {
    await this.ensureWatching();
    this.log(`watching (local), ${this.allowed.size} chat(s) allowlisted`);
  }

  async postMessage(chatId: string, text: string): Promise<MessageRef> {
    this.rememberSend(text);
    // Listen before sending so a fast chat.db row isn't missed.
    const sentId = this.awaitSentId(chatId, text);
    void this.ensureWatching();
    await this.sdk.send({ to: chatId, text });
    const id = await sentId;
    if (id) this.ourMessageIds.add(id);
    return id ? { id, chatId } : this.makeRef(chatId);
  }

  async postImage(chatId: string, image: ImageRef, caption?: string): Promise<MessageRef> {
    if (caption) this.rememberSend(caption);
    // imessage-kit sends local file paths; callers must localize remote URIs first.
    await this.sdk.send({ to: chatId, text: caption, attachments: [image.uri] });
    return this.makeRef(chatId);
  }

  async sendDirectMessage(handle: string, text: string): Promise<MessageRef> {
    this.rememberSend(text);
    // A bare handle (phone/email) routes to a 1-on-1 DM inside the SDK.
    await this.sdk.send({ to: handle, text });
    return this.makeRef(handle);
  }

  onMessage(handler: MessageHandler): Unsubscribe {
    this.messageHandlers.add(handler);
    void this.ensureWatching();
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onReaction(handler: ReactionHandler): Unsubscribe {
    this.reactionHandlers.add(handler);
    void this.ensureWatching();
    return () => {
      this.reactionHandlers.delete(handler);
    };
  }

  /** Stop the watcher and release the SDK. Not part of ChatPort; call on shutdown. */
  async close(): Promise<void> {
    this.messageHandlers.clear();
    this.reactionHandlers.clear();
    await this.sdk.close();
    this.watchStarting = undefined;
  }

  /** Fallback id when the sent row's guid wasn't seen in time. A 👍 on it can't be matched. */
  private makeRef(chatId: string): MessageRef {
    return { id: `local:${randomUUID()}`, chatId };
  }

  private rememberSend(text: string): void {
    this.recentSendTexts.push(text);
    if (this.recentSendTexts.length > RECENT_SENDS) this.recentSendTexts.shift();
  }

  /**
   * `send()` resolves on AppleScript dispatch and never returns the chat.db guid. The watcher's
   * from-me rows carry it, so wait for the next from-me row in this chat with the same text.
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

  /** True if a from-me row is one of the bot's own sends (matched now, or seen before). */
  private isOurSend(message: Message): boolean {
    if (this.ourMessageIds.has(message.id)) return true;
    if (message.reaction || message.text === null) return false;
    const i = this.pendingSends.findIndex(
      (p) => p.text === message.text && (message.chatId === null || p.chatId === message.chatId),
    );
    if (i >= 0) {
      const [entry] = this.pendingSends.splice(i, 1);
      this.ourMessageIds.add(message.id);
      entry?.resolve(message.id);
      return true;
    }
    // A late echo of something we sent after its wait timed out.
    return this.recentSendTexts.includes(message.text);
  }

  /** Start the single shared watcher on first use (idempotent; the SDK allows only one). */
  private ensureWatching(): Promise<void> {
    this.watchStarting ??= this.sdk
      .startWatching({
        onIncomingMessage: (message) => this.dispatch(message),
        onFromMeMessage: (message) => {
          if (this.isOurSend(message)) return;
          if (this.selfHandle) this.dispatch(message);
        },
        onError: (error) => this.onError(error),
      })
      .catch((error: unknown) => {
        this.watchStarting = undefined;
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
    return this.watchStarting;
  }

  /** Route one watcher row to reaction or message handlers (never both). */
  private dispatch(message: Message): void {
    if (message.chatId === null || !this.allowed.has(message.chatId)) {
      // Never log other chats' text. The claim word only reveals the chat id.
      if (message.text?.toLowerCase().includes(CLAIM_WORD)) {
        this.log(`claim: add ${message.chatId} to the allowlist`);
      }
      return;
    }
    try {
      if (message.reaction) {
        const reaction = mapReactionRow(message, this.resolveSender, this.selfHandle);
        if (reaction) {
          this.log(`👍 ${reaction.added ? "on" : "removed from"} ${reaction.targetMessageId} by ${reaction.senderHandle}`);
          for (const handler of this.reactionHandlers) handler(reaction);
        }
        return;
      }
      const msg = mapMessageRow(message, this.resolveSender, this.selfHandle);
      if (!msg) return;
      for (const handler of this.messageHandlers) handler(msg);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
