import { parseAbi } from "viem";

/** The parts of GroupTreasury (contracts/src/GroupTreasury.sol) this page calls. */
export const treasuryAbi = parseAbi([
  "function join(bytes32 group, uint128 limit, uint8 period, bytes32 ticket)",
  "function setLimit(bytes32 group, uint128 limit, uint8 period)",
  "function members(bytes32 group, address member) view returns (bool active, uint8 period, uint128 limit, uint64 windowIndex, uint128 spent)",
  "function ticketUsed(bytes32 ticket) view returns (bool)",
  "function remaining(bytes32 group, address member) view returns (uint256)",
  "function resetsAt(bytes32 group, address member) view returns (uint256)",
  "function debts(address debtor, address creditor) view returns (uint256)",
  "function payDebt(address creditor, uint256 amount)",
]);

/** GroupTreasury's events, for the history views (src/history.ts). */
export const treasuryEvents = parseAbi([
  "event Joined(bytes32 indexed group, address indexed member, uint256 limit, uint8 period, bytes32 ticket)",
  "event Left(bytes32 indexed group, address indexed member, address indexed by)",
  "event LimitSet(bytes32 indexed group, address indexed member, uint256 limit, uint8 period, address by)",
  "event SpendProposed(bytes32 indexed id, bytes32 indexed group, address indexed payee, uint256 total, uint64 deadline)",
  "event SpendApproved(bytes32 indexed id, address indexed member)",
  "event SpendCancelled(bytes32 indexed id)",
  "event SharePulled(bytes32 indexed id, address indexed from, address indexed to, uint256 amount)",
  "event PullFailed(bytes32 indexed id, address indexed from, address indexed to, uint256 amount, string reason)",
  "event SpendSettled(bytes32 indexed id, uint256 pulled, uint256 owed)",
  "event DebtPaid(address indexed debtor, address indexed creditor, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
