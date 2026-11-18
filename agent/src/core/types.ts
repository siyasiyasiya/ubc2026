/** Phone number or email that identifies a member in iMessage. */
export type Handle = string;

/** USDC amounts are integers in base units (6 decimals): $1.00 === 1_000_000. */
export type Units = number;

export interface Member {
  handle: Handle;
  name: string;
  /** Most this member can be charged per week (Monday to Sunday). */
  weeklyLimit: Units;
}

/** "buy": the agent buys something now. "reimburse": someone already paid (dinner) and is paid back. */
export type ProposalKind = "buy" | "reimburse";

export type ProposalStatus = "pending" | "settled" | "rejected" | "cancelled";

export interface Transfer {
  from: Handle;
  to: Handle;
  amount: Units;
}

export interface Settlement {
  ok: boolean;
  transfers: Transfer[];
  /** Transaction hash (onchain) or mock reference. */
  reference?: string;
  error?: string;
}

export interface Proposal {
  /** Short number shown in chat, e.g. 3 for "#3". */
  number: number;
  kind: ProposalKind;
  title: string;
  total: Units;
  /** Who paid (or whose card the agent uses) and gets paid back. */
  payer: Handle;
  /** Each participant's share, including the payer's own share. */
  shares: Record<Handle, Units>;
  /** Participants (other than the payer) who tapped 👍. */
  approvals: Handle[];
  status: ProposalStatus;
  createdBy: Handle;
  createdAt: string;
  /** iMessage id of the approval card, so a 👍 on it can be matched. */
  cardMessageId?: string;
  settlement?: Settlement;
}

export interface GroupState {
  spaceId: string;
  members: Member[];
  proposals: Proposal[];
  /** Charged so far this week, per member, to enforce weekly limits. */
  spending: Record<Handle, { weekStart: string; amount: Units }>;
}
