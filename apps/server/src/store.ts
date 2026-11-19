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
  buy?: { participants: MemberId[]; payer: MemberId };
  createdAt: number;
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
}

interface StoreFile {
  groups: Record<string, GroupRecord>;
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
