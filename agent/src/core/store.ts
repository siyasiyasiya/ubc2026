import fs from "node:fs";
import path from "node:path";
import type { GroupState, Handle, Member, Proposal, Units } from "./types.js";

interface StoreFile {
  groups: Record<string, GroupState>;
}

/** Small JSON-file store. Good enough for one bot process; swap for a DB if we ever run several. */
export class Store {
  private data: StoreFile;

  constructor(
    private readonly file: string,
    private readonly defaults: { weeklyLimit: Units; names: Record<Handle, string> },
  ) {
    this.data = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile)
      : { groups: {} };
  }

  group(spaceId: string): GroupState {
    let group = this.data.groups[spaceId];
    if (!group) {
      group = { spaceId, members: [], proposals: [], spending: {} };
      this.data.groups[spaceId] = group;
    }
    return group;
  }

  /** Adds anyone who talks in the group as a member, with the default weekly limit. */
  ensureMember(group: GroupState, handle: Handle): Member {
    let member = group.members.find((m) => m.handle === handle);
    if (!member) {
      member = {
        handle,
        name: this.defaults.names[handle] ?? `…${handle.slice(-4)}`,
        weeklyLimit: this.defaults.weeklyLimit,
      };
      group.members.push(member);
    }
    return member;
  }

  nextProposalNumber(group: GroupState): number {
    return group.proposals.reduce((max, p) => Math.max(max, p.number), 0) + 1;
  }

  findProposal(group: GroupState, number: number): Proposal | undefined {
    return group.proposals.find((p) => p.number === number);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export function memberName(group: GroupState, handle: Handle): string {
  return group.members.find((m) => m.handle === handle)?.name ?? handle;
}
