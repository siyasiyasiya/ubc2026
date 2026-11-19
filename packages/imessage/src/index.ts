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
  type Chat,
  type ChatQuery,
  type DispatchEvents,
  type IMessageConfig,
  type Message,
  type MessageQuery,
  type Reaction,
  type SendRequest,
} from "@photon-ai/imessage-kit";

/** The emoji the group-treasury flow treats as an "approve". */
const THUMBS_UP = "👍";

/** A message containing this word reveals its chat id in the logs, so it can be allowlisted. */
const CLAIM_WORD = "#treasury";

/** Clock slack when deciding a row predates the watcher (chat.db stamps can lag the send). */
const REPLAY_SLACK_MS = 2000;

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
  /** Lists chats the bot is in, so it can auto-serve every group it's been added to. */
  listChats(query?: ChatQuery): Promise<readonly Chat[]>;
  /** Re-reads rows from chat.db, used to wait for an attachment's file to finish downloading. */
  getMessages(query?: MessageQuery): Promise<readonly Message[]>;
}

/** Returns the sender's handle for a message id, or null if unknown. */
export type SenderResolver = (messageId: string) => string | null;

/**
 * Finds the guid of the first message I sent in a chat at or after `sinceMs`, skipping `exclude`.
 * Used to learn a sent message's id without relying on its text.
 */
export type SentIdLookup = (chatId: string, sinceMs: number, exclude: ReadonlySet<string>) => string | null;

/** Returns the participant handles of a (group) chat, or an empty list if unknown. */
export type ParticipantsResolver = (chatId: string) => string[];

/** Returns a chat's display name, or null if it has none (unnamed groups) or can't be read. */
export type ChatNameResolver = (chatId: string) => string | null;

export interface PhotonChatPortConfig {
  /**
   * Explicit chat allowlist. Leave empty to auto-serve every group chat the bot is in (via
   * `listChats`), which is the norm when the bot runs on its own Apple ID. When non-empty, only
   * these chats are served and no auto-discovery happens.
   */
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
   * How to read a group chat's participant roster. Defaults to a read-only chat.db lookup when the
   * real SDK is used; pass `null` to disable (getParticipants then returns an empty list).
   */
  resolveParticipants?: ParticipantsResolver | null;
  /**
   * How to read a chat's display name. Defaults to a read-only chat.db lookup when the real SDK is
   * used; pass `null` to disable (getChatName then returns null).
   */
  resolveChatName?: ChatNameResolver | null;
  /**
   * While the bot runs on a member's own Apple ID, that member's messages and 👍s are "from me".
   * Set this to their handle to treat them as that member. The bot's own sends are still skipped.
   */
  selfHandle?: string;
  /** How long postMessage waits for the sent row to appear in chat.db to learn its id. */
  sentIdTimeoutMs?: number;
  /**
   * Finds a sent message's guid in chat.db. Defaults to a read-only chat.db query when the real
   * SDK is used; pass `null` to rely on the watcher only.
   */
  sentIdLookup?: SentIdLookup | null;
  /** How often postMessage polls `sentIdLookup` while waiting. */
  sentIdPollMs?: number;
  /** How long to wait for an incoming attachment's file to finish downloading before giving up. */
  attachmentWaitMs?: number;
  /** How often to re-check chat.db while an attachment is still transferring. */
  attachmentPollMs?: number;
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

/** chat.db stores dates as nanoseconds since 2001-01-01. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/**
 * Read-only chat.db lookup of my first plain (non-reaction) message in a chat since a time. Works
 * even when `message.text` is NULL, which newer macOS does for sent rows (text lives in
 * `attributedBody`), so matching on text alone misses them.
 */
export function chatDbSentIdLookup(databasePath?: string): SentIdLookup {
  let db: Database.Database | undefined;
  let stmt: Database.Statement<[string, bigint], { guid: string }> | undefined;
  return (chatId, sinceMs, exclude) => {
    try {
      db ??= new Database(databasePath ?? path.join(os.homedir(), "Library/Messages/chat.db"), {
        readonly: true,
        fileMustExist: true,
      });
      stmt ??= db.prepare(
        `SELECT m.guid AS guid FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE c.guid = ? AND m.is_from_me = 1 AND m.associated_message_type = 0 AND m.date >= ?
         ORDER BY m.ROWID ASC LIMIT 20`,
      );
      // A second of slack: chat.db stamps the row slightly before send() resolves.
      const since = BigInt(Math.max(0, sinceMs - 1000 - APPLE_EPOCH_MS)) * 1_000_000n;
      return stmt.all(chatId, since).find((r) => !exclude.has(r.guid))?.guid ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * Read-only chat.db lookup of a group chat's participant handles (needs Full Disk Access). The
 * local account (the bot) isn't a row in `handle`, so the roster is exactly the other members.
 */
export function chatDbParticipants(databasePath?: string): ParticipantsResolver {
  let db: Database.Database | undefined;
  let stmt: Database.Statement<[string, string], { handle: string }> | undefined;
  return (chatId) => {
    try {
      db ??= new Database(databasePath ?? path.join(os.homedir(), "Library/Messages/chat.db"), {
        readonly: true,
        fileMustExist: true,
      });
      // imessage-kit routes with chat.guid (e.g. "iMessage;+;chat123"); match chat_identifier too.
      stmt ??= db.prepare(
        "SELECT h.id AS handle FROM chat c JOIN chat_handle_join chj ON chj.chat_id = c.ROWID JOIN handle h ON h.ROWID = chj.handle_id WHERE c.guid = ? OR c.chat_identifier = ?",
      );
      return stmt.all(chatId, chatId).map((r) => r.handle);
    } catch {
      return [];
    }
  };
}

/** Read-only chat.db lookup of a chat's display name. Empty/absent names (unnamed groups) return null. */
export function chatDbChatName(databasePath?: string): ChatNameResolver {
  let db: Database.Database | undefined;
  let stmt: Database.Statement<[string, string], { display_name: string | null }> | undefined;
  return (chatId) => {
    try {
      db ??= new Database(databasePath ?? path.join(os.homedir(), "Library/Messages/chat.db"), {
        readonly: true,
        fileMustExist: true,
      });
      stmt ??= db.prepare("SELECT display_name FROM chat WHERE guid = ? OR chat_identifier = ?");
      const name = stmt.get(chatId, chatId)?.display_name?.trim();
      return name ? name : null;
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
  /** Chats the bot serves. Seeded from config, or grown from `listChats` when auto-serving. */
  private readonly allowed: Set<string>;
  /** Empty allowlist => serve every group chat the bot is in. */
  private readonly autoServe: boolean;
  /** Chats a refresh confirmed aren't group chats we serve (e.g. DMs), so we don't re-check them. */
  private readonly notServed = new Set<string>();
  private refreshing: Promise<void> | undefined;
  private readonly resolveSender: SenderResolver | undefined;
  private readonly resolveParticipants: ParticipantsResolver | undefined;
  private readonly resolveChatName: ChatNameResolver | undefined;
  private readonly selfHandle: string | undefined;
  private readonly sentIdTimeoutMs: number;
  private readonly sentIdPollMs: number;
  private readonly attachmentWaitMs: number;
  private readonly attachmentPollMs: number;
  private readonly sentIdLookup: SentIdLookup | undefined;
  private readonly log: (line: string) => void;
  private readonly onError: (error: Error) => void;

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly reactionHandlers = new Set<ReactionHandler>();
  private readonly directHandlers = new Set<MessageHandler>();
  /** Sends waiting to learn their chat.db id from the watcher's from-me rows. */
  private readonly pendingSends: { chatId: string; text: string; resolve: (id: string) => void }[] = [];
  /** Sends are serialized so each one claims the next sent row in its chat, in order. */
  private sendQueue: Promise<unknown> = Promise.resolve();
  /** Texts and guids of our own recent sends, so their echoes are never treated as input. */
  private readonly recentSendTexts: string[] = [];
  private readonly ourMessageIds = new Set<string>();
  private watchStarting: Promise<void> | undefined;
  /** Rows created before the watcher started are history, not new input (the watcher replays some). */
  private watchStartedAt = Number.POSITIVE_INFINITY;

  constructor(config: PhotonChatPortConfig) {
    if (config.mode === "cloud") {
      throw new Error("@gta/imessage only supports local mode (imessage-kit on a Mac)");
    }
    this.sdk = config.sdk ?? new IMessageSDK(config.sdkConfig);
    this.allowed = new Set(config.allowedChatIds);
    this.autoServe = config.allowedChatIds.length === 0;
    this.resolveSender =
      config.resolveSender === null
        ? undefined
        : (config.resolveSender ??
          (config.sdk ? undefined : chatDbSenderResolver(config.sdkConfig?.databasePath)));
    this.resolveParticipants =
      config.resolveParticipants === null
        ? undefined
        : (config.resolveParticipants ??
          (config.sdk ? undefined : chatDbParticipants(config.sdkConfig?.databasePath)));
    this.resolveChatName =
      config.resolveChatName === null
        ? undefined
        : (config.resolveChatName ?? (config.sdk ? undefined : chatDbChatName(config.sdkConfig?.databasePath)));
    this.selfHandle = config.selfHandle;
    this.sentIdTimeoutMs = config.sentIdTimeoutMs ?? 10_000;
    this.sentIdPollMs = config.sentIdPollMs ?? 250;
    this.attachmentWaitMs = config.attachmentWaitMs ?? 20_000;
    this.attachmentPollMs = config.attachmentPollMs ?? 750;
    this.sentIdLookup =
      config.sentIdLookup === null
        ? undefined
        : (config.sentIdLookup ??
          (config.sdk ? undefined : chatDbSentIdLookup(config.sdkConfig?.databasePath)));
    this.log = config.log ?? ((line) => console.log(`[imessage] ${line}`));
    this.onError = config.onError ?? ((error) => this.log(`watcher error: ${error.message}`));
  }

  /** Starts watching Messages. Resolves once the watcher is running; events keep arriving after. */
  async start(): Promise<void> {
    await this.ensureWatching();
    if (this.autoServe) await this.refreshServed();
    this.log(
      this.autoServe
        ? `watching (local), auto-serving ${this.allowed.size} group chat(s)`
        : `watching (local), ${this.allowed.size} chat(s) allowlisted`,
    );
  }

  /** Pull the group chats the bot is in into the served set. Safe to call repeatedly. */
  private async refreshServed(): Promise<void> {
    try {
      const chats = await this.sdk.listChats({ kind: "group" });
      for (const chat of chats) this.allowed.add(chat.chatId);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  postMessage(chatId: string, text: string): Promise<MessageRef> {
    const run = async (): Promise<MessageRef> => {
      this.rememberSend(text);
      const startedAt = Date.now();
      // Listen before sending so a fast chat.db row isn't missed.
      const sentId = this.awaitSentId(chatId, text, startedAt);
      void this.ensureWatching();
      await this.sdk.send({ to: chatId, text });
      const id = await sentId;
      if (id) this.ourMessageIds.add(id);
      else this.log(`couldn't learn the id of a message sent to ${chatId}; a 👍 on it won't match`);
      return id ? { id, chatId } : this.makeRef(chatId);
    };
    const result = this.sendQueue.then(run, run);
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  postImage(chatId: string, image: ImageRef, caption?: string): Promise<MessageRef> {
    const run = async (): Promise<MessageRef> => {
      if (caption) this.rememberSend(caption);
      const startedAt = Date.now();
      // Learn the sent row's id (same as postMessage) so a 👍 on the screenshot card can be matched.
      const sentId = this.awaitSentId(chatId, caption ?? "", startedAt);
      void this.ensureWatching();
      // imessage-kit sends local file paths; callers must localize remote URIs first.
      await this.sdk.send({ to: chatId, text: caption, attachments: [image.uri] });
      const id = await sentId;
      if (id) this.ourMessageIds.add(id);
      return id ? { id, chatId } : this.makeRef(chatId);
    };
    const result = this.sendQueue.then(run, run);
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  async sendDirectMessage(handle: string, text: string): Promise<MessageRef> {
    this.rememberSend(text);
    // A bare handle (phone/email) routes to a 1-on-1 DM inside the SDK.
    await this.sdk.send({ to: handle, text });
    return this.makeRef(handle);
  }

  /** The chat's roster from chat.db, deduped. The bot's own handle is never a row, but drop it defensively. */
  async getParticipants(chatId: string): Promise<string[]> {
    if (!this.resolveParticipants) return [];
    return [...new Set(this.resolveParticipants(chatId))].filter((h) => h !== this.selfHandle);
  }

  /** The chat's display name from chat.db, or null if it has none. */
  async getChatName(chatId: string): Promise<string | null> {
    return this.resolveChatName ? this.resolveChatName(chatId) : null;
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

  onDirectMessage(handler: MessageHandler): Unsubscribe {
    this.directHandlers.add(handler);
    void this.ensureWatching();
    return () => {
      this.directHandlers.delete(handler);
    };
  }

  /** Stop the watcher and release the SDK. Not part of ChatPort; call on shutdown. */
  async close(): Promise<void> {
    this.messageHandlers.clear();
    this.reactionHandlers.clear();
    this.directHandlers.clear();
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
  private awaitSentId(chatId: string, text: string, startedAt: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const finish = (id: string | undefined) => {
        if (done) return;
        done = true;
        const i = this.pendingSends.indexOf(entry);
        if (i >= 0) this.pendingSends.splice(i, 1);
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        resolve(id);
      };
      const entry = { chatId, text, resolve: (id: string) => finish(id) };
      this.pendingSends.push(entry);
      const timer = setTimeout(() => finish(undefined), this.sentIdTimeoutMs);
      timer.unref?.();
      const lookup = this.sentIdLookup;
      if (lookup) {
        poll = setInterval(() => {
          const id = lookup(chatId, startedAt, this.ourMessageIds);
          if (id) finish(id);
        }, this.sentIdPollMs);
        poll.unref?.();
      }
    });
  }

  /** True if a from-me row is one of the bot's own sends (matched now, or seen before). */
  private isOurSend(message: Message): boolean {
    if (this.ourMessageIds.has(message.id)) return true;
    if (message.reaction) return false;
    const sameChat = (p: { chatId: string }) => message.chatId === null || p.chatId === message.chatId;
    // Newer macOS leaves `text` NULL on sent rows, so a text-less row claims the oldest send
    // waiting in its chat.
    const i = this.pendingSends.findIndex((p) =>
      message.text === null ? sameChat(p) : p.text === message.text && sameChat(p),
    );
    if (i >= 0) {
      const [entry] = this.pendingSends.splice(i, 1);
      this.ourMessageIds.add(message.id);
      entry?.resolve(message.id);
      return true;
    }
    // A late echo of something we sent after its wait timed out.
    return message.text !== null && this.recentSendTexts.includes(message.text);
  }

  /** Start the single shared watcher on first use (idempotent; the SDK allows only one). */
  private ensureWatching(): Promise<void> {
    if (!this.watchStarting) this.watchStartedAt = Date.now() - REPLAY_SLACK_MS;
    this.watchStarting ??= this.sdk
      .startWatching({
        onIncomingMessage: (message) => void this.dispatch(message),
        onFromMeMessage: (message) => {
          if (this.isHistory(message)) return;
          if (this.isOurSend(message)) return;
          if (this.selfHandle) void this.dispatch(message);
        },
        onError: (error) => this.onError(error),
      })
      .catch((error: unknown) => {
        this.watchStarting = undefined;
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
    return this.watchStarting;
  }

  /** Rows created before the watcher started are history the watcher replays, not new input. */
  private isHistory(message: Message): boolean {
    return message.createdAt.getTime() < this.watchStartedAt;
  }

  /**
   * Gate one watcher row. The allowlisted path is synchronous (handlers fire before this returns);
   * only discovering a just-added group in auto-serve mode goes async.
   */
  private dispatch(message: Message): void {
    if (this.isHistory(message)) return;
    const chatId = message.chatId;
    if (chatId === null) return;
    // A 1-on-1 message to the bot is inherently its own conversation: no allowlist, no roster.
    if (message.chatKind === "dm") {
      this.deliverDirect(message);
      return;
    }
    if (this.allowed.has(chatId)) {
      this.deliver(message);
      return;
    }
    if (this.autoServe && !this.notServed.has(chatId)) {
      void this.discoverThenDeliver(chatId, message);
      return;
    }
    // Never log other chats' text. The claim word only reveals the chat id.
    if (message.text?.toLowerCase().includes(CLAIM_WORD)) {
      this.log(`claim: add ${chatId} to the allowlist`);
    }
  }

  /** A chat the bot isn't serving yet: refresh the group list once, then deliver if it's one we're in. */
  private async discoverThenDeliver(chatId: string, message: Message): Promise<void> {
    this.refreshing ??= this.refreshServed().finally(() => (this.refreshing = undefined));
    await this.refreshing;
    if (this.allowed.has(chatId)) this.deliver(message);
    else this.notServed.add(chatId); // a DM or a chat we're not in; stop re-checking it
  }

  /** Route one served row to reaction or message handlers (never both). */
  private deliver(message: Message): void {
    try {
      if (message.reaction) {
        const reaction = mapReactionRow(message, this.resolveSender, this.selfHandle);
        if (reaction) {
          this.log(`👍 ${reaction.added ? "on" : "removed from"} ${reaction.targetMessageId} by ${reaction.senderHandle}`);
          for (const handler of this.reactionHandlers) handler(reaction);
        }
        return;
      }
      // Log every attachment row's state so a "can't read images" report can be diagnosed from the
      // terminal: did the file arrive, what type is it, is it still transferring, is it on disk?
      if (message.hasAttachments || message.attachments.length > 0) {
        const states = message.attachments
          .map((a) => `${a.mimeType || "?"} ${a.transferStatus}${a.localPath ? " on-disk" : " no-file"}`)
          .join(", ");
        this.log(`attachment row ${message.id}: hasAttachments=${message.hasAttachments}, ${message.attachments.length} att [${states || "none yet"}]`);
      }
      // An attachment (receipt photo/PDF) often isn't on disk the instant its row appears: the file
      // is still downloading, or the message_attachment_join hasn't flushed yet (a WAL race). Emitting
      // now would hand the agent a text-less row and it'd say "can't see images", so wait for the file.
      if (this.attachmentsPending(message)) {
        void this.deliverWhenReady(message);
        return;
      }
      this.emitMessage(message);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Fire the message handlers for a row, skipping rows with neither text nor a usable attachment. */
  private emitMessage(message: Message): void {
    const msg = mapMessageRow(message, this.resolveSender, this.selfHandle);
    // Text-less, photo-less rows (e.g. a from-me echo whose text lives in attributedBody) aren't input.
    if (!msg || (!msg.text && msg.attachments.length === 0)) return;
    for (const handler of this.messageHandlers) handler(msg);
  }

  /** A usable attachment: its file is on disk (localPath set) and the transfer isn't still in flight. */
  private static attachmentReady(message: Message): boolean {
    return message.attachments.some(
      (a) => a.localPath !== null && a.transferStatus !== "pending" && a.transferStatus !== "transferring",
    );
  }

  /** The row claims an attachment, but none is ready yet and the transfer hasn't permanently failed. */
  private attachmentsPending(message: Message): boolean {
    // `hasAttachments` covers the WAL race (row visible before its join flushes, so attachments is
    // still empty); a non-empty attachments list covers a file that's present but still downloading.
    const claimsAttachment = message.hasAttachments || message.attachments.length > 0;
    if (!claimsAttachment || PhotonChatPort.attachmentReady(message)) return false;
    // A failed transfer never completes, so don't wait on it; let the row through (text only).
    const allFailed = message.attachments.length > 0 && message.attachments.every((a) => a.transferStatus === "failed");
    return !allFailed;
  }

  /** Re-read the row from chat.db until its attachment's file lands, then emit; give up after a timeout. */
  private async deliverWhenReady(provisional: Message): Promise<void> {
    const chatId = provisional.chatId;
    if (!chatId) {
      this.emitMessage(provisional);
      return;
    }
    this.log(`waiting for attachment to download (${provisional.id})`);
    const deadline = Date.now() + this.attachmentWaitMs;
    // A hair before the row's own timestamp, so the query can't miss it on a rounding boundary.
    const since = new Date(provisional.createdAt.getTime() - 1000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.attachmentPollMs));
      let rows: readonly Message[];
      try {
        rows = await this.sdk.getMessages({ chatId, since, excludeReactions: true });
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      const fresh = rows.find((m) => m.id === provisional.id);
      if (fresh && !this.attachmentsPending(fresh)) {
        this.emitMessage(fresh);
        return;
      }
    }
    // Timed out: emit what we last had so any text still reaches the agent.
    this.log(`attachment never finished downloading (${provisional.id}), delivering without it`);
    this.emitMessage(provisional);
  }

  /** Route a private 1-on-1 message to the DM handlers (account questions). Reactions on DMs are ignored. */
  private deliverDirect(message: Message): void {
    try {
      if (message.reaction) return;
      const msg = mapMessageRow(message, this.resolveSender, this.selfHandle);
      if (!msg || !msg.text) return;
      this.log(`dm from ${msg.senderHandle}`);
      for (const handler of this.directHandlers) handler(msg);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
