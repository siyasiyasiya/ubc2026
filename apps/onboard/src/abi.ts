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

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
