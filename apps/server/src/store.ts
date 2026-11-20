import fs from "node:fs";
import path from "node:path";
import type { Group, MemberId, RequestState, SpendingLimit, Split, SpendFlow } from "@gta/core";

/** A spend request and where it is in the core state machine. */
export interface RequestRecord {
  id: string;
  /** Short number shown in chat, e.g. 3 for "#3". */
  number: number;
  title: string;
  flow: SpendFlow;
  requesterId: MemberId;
  state: RequestState;
  /** The split currently on the table (kept outside the state so terminal states can show it). */
  split?: Split;
  /** iMessage id of the approval card, so a 👍 on it can be matched. */
  previewMessageId?: string;
  /** Approved but held on the group's tab until someone says "settle up" (e.g. end of a trip). */
  onTab?: boolean;
  /** Pay-before: who's in the split and whose card pays the store (they get paid back). */
  buy?: { participants: MemberId[]; payer: MemberId; card?: { userId: string; paymentMethodId: string } };
  /** Part of a subscription: its setup card (approved once by everyone) or one of its charges. */
  subscriptionId?: string;
  /** A scheduled subscription charge: already approved when the group started it, so no card. */
  charge?: boolean;
  createdAt: number;
}

/**
 * Something the group pays for on repeat (Spotify, rent, a cleaner). Everyone 👍s it once; Kitty
 * then charges the same split every period through the contract, never past anyone's cap.
 */
export interface Subscription {
  id: string;
  title: string;
  every: "weekly" | "monthly";
  split: Split;
  /** pending: waiting on 👍s for the setup card. active: charging. cancelled: stopped for good. */
  status: "pending" | "active" | "cancelled";
  /** The setup card everyone 👍s; its settle is the first charge. */
  setupRequestId: string;
  createdBy: MemberId;
  createdAt: number;
  /** When the next charge is due (set once it starts). */
  nextAt?: number;
  charges: number;
  cancelledBy?: MemberId;
}

/** The group's saved "usual" for a generic item, so Kitty buys it instead of asking every time. */
export interface Preference {
  /** The item as it was asked for, e.g. "dishwasher soap" (display form of the key). */
  item: string;
  /** What to buy for it, e.g. "Cascade Platinum pods". */
  choice: string;
  /** Who set it, and when. */
  setBy: MemberId;
  at: number;
}

export interface GroupRecord {
  group: Group;
  requests: RequestRecord[];
  /** Latest Face ID invite nonce per handle; tickets for nonces 0..n are valid. */
  inviteNonces?: Record<string, number>;
  /** The chat's plan: each person's limit here, refilling weekly/monthly or once for a trip. */
  plan?: SpendingLimit;
  /** Handles we asked "what should I call you?" privately; their Face ID link goes out once they answer. */
  awaitingName?: string[];
  /** The group's shared usuals for generic buys, keyed by the normalized item name (see normalizePreferenceKey). */
  preferences?: Record<string, Preference>;
  /** Each member's personal usuals, by member id then normalized item name. A member's own pick wins over the group's. */
  memberPreferences?: Record<MemberId, Record<string, Preference>>;
  /** Recurring splits this chat pays on repeat. */
  subscriptions?: Subscription[];
}

/** Normalize an item name to a stable preference key: lowercase, trimmed, whitespace collapsed. */
export function normalizePreferenceKey(item: string): string {
  return item.toLowerCase().trim().replace(/\s+/g, " ");
}

/** A member's own saved card (Crossmint), so when Kitty buys something they're paying for, it's their card. */
export interface SavedCard {
  /** Their Crossmint user (the card belongs to it; checkout and charge must use the same one). */
  userId: string;
  paymentMethodId: string;
  /** "visa ending 4242", as the save page reported it. */
  label?: string;
  at: number;
}

interface StoreFile {
  groups: Record<string, GroupRecord>;
  /** Saved cards by member handle (cards are per person, across all their chats). */
  cards?: Record<string, SavedCard>;
  /** Next Arc block the Face ID join watcher should scan. */
  joinCursor?: bigint;
  /** Accounts already sent a testnet welcome balance, so a replayed join never pays twice. */
  welcomed?: string[];
}

// USDC amounts are bigints; JSON can't hold them natively.
const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? { $bigint: value.toString() } : value;
const reviver = (_key: string, value: unknown) =>
  value !== null && typeof value === "object" && "$bigint" in value && Object.keys(value).length === 1
    ? BigInt((value as { $bigint: string }).$bigint)
    : value;

/** Small JSON-file store for one bot process. Swap for a database if we ever run several. */
export class Store {
  private data: StoreFile;

  constructor(private readonly file?: string) {
    this.data =
      file && fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8"), reviver) as StoreFile)
        : { groups: {} };
  }

  get(chatId: string): GroupRecord | undefined {
    return this.data.groups[chatId];
  }

  all(): GroupRecord[] {
    return Object.values(this.data.groups);
  }

  get joinCursor(): bigint | undefined {
    return this.data.joinCursor;
  }

  set joinCursor(block: bigint | undefined) {
    this.data.joinCursor = block;
  }

  hasWelcomed(account: string): boolean {
    return (this.data.welcomed ?? []).includes(account.toLowerCase());
  }

  markWelcomed(account: string, welcomed = true): void {
    const set = new Set(this.data.welcomed ?? []);
    if (welcomed) set.add(account.toLowerCase());
    else set.delete(account.toLowerCase());
    this.data.welcomed = [...set];
  }

  card(handle: string): SavedCard | undefined {
    return this.data.cards?.[handle];
  }

  saveCard(handle: string, card: SavedCard): void {
    (this.data.cards ??= {})[handle] = card;
  }

  put(record: GroupRecord): void {
    this.data.groups[record.group.chatId] = record;
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, replacer, 2));
    fs.renameSync(tmp, this.file);
  }
}
