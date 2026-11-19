import fs from "node:fs";
import path from "node:path";
import type { Group, MemberId, RequestState, Split, SpendFlow } from "@gta/core";

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
  createdAt: number;
}

export interface GroupRecord {
  group: Group;
  requests: RequestRecord[];
}

interface StoreFile {
  groups: Record<string, GroupRecord>;
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
