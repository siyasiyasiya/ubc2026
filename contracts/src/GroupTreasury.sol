// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title GroupTreasury
/// @notice One deployment serves every group chat. A group is keyed by a hash of its chat id, and
/// membership and limits are per group, so the same person can be in several chats with a
/// different limit in each, and chats can gain and lose members over time. Money stays in each
/// member's own wallet (one USDC approval to this contract covers all their groups); when a split
/// is approved by everyone in it, each share is pulled straight to whoever paid, never more than
/// what is left of that member's recurring limit in that group.
///
/// Trust model: members' wallets are passkey (Face ID) smart accounts. Joining a group, choosing
/// and raising a limit are signed by the member. The operator is the chat agent's key: it proposes
/// splits, relays each member's 👍 (`approveFor`), lowers limits and removes people who left the
/// chat. It can never add a member, raise a limit, or send money anywhere but the payee of a
/// split, and no pull ever exceeds what is left of the limit the member signed for that group.
contract GroupTreasury {
    /// Weekly and Monthly refill each period (unspent money never left the member's account, and
    /// what can be pulled never goes above the limit). Once is for trips: the limit never refills.
    enum Period {
        Weekly,
        Monthly,
        Once
    }

    enum Status {
        None,
        Proposed,
        Settled,
        Cancelled
    }

    struct Member {
        bool active;
        Period period;
        uint128 limit; // USDC base units (6 decimals) per period
        uint64 windowIndex; // which period `spent` belongs to
        uint128 spent;
    }

    struct Spend {
        Status status;
        bytes32 group;
        address payee;
        uint64 deadline;
        uint32 approvalsNeeded;
        uint32 approvals;
        uint256 total;
        address[] participants;
        uint256[] shares;
    }

    /// Weekly windows start Monday 00:00 UTC (1970-01-05), matching the off-chain adapter.
    uint256 internal constant ANCHOR = 4 days;
    /// Months are fixed 30-day windows: calendar months aren't worth the gas or the bugs.
    uint256 internal constant MONTH = 30 days;

    IERC20 public immutable usdc;
    address public immutable operator;

    /// members[group][wallet]
    mapping(bytes32 => mapping(address => Member)) public members;
    mapping(bytes32 => Spend) internal spends;
    mapping(bytes32 => mapping(address => bool)) public approved;
    /// debts[debtor][creditor]: shares that could not be pulled, across all groups.
    mapping(address => mapping(address => uint256)) public debts;
    mapping(bytes32 => bool) public ticketUsed;

    event Joined(
        bytes32 indexed group, address indexed member, uint256 limit, Period period, bytes32 ticket
    );
    event Left(bytes32 indexed group, address indexed member, address indexed by);
    event LimitSet(
        bytes32 indexed group, address indexed member, uint256 limit, Period period, address by
    );
    event SpendProposed(
        bytes32 indexed id,
        bytes32 indexed group,
        address indexed payee,
        uint256 total,
        uint64 deadline
    );
    event SpendApproved(bytes32 indexed id, address indexed member);
    event SpendCancelled(bytes32 indexed id);
    event SharePulled(bytes32 indexed id, address indexed from, address indexed to, uint256 amount);
    event PullFailed(
        bytes32 indexed id, address indexed from, address indexed to, uint256 amount, string reason
    );
    event SpendSettled(bytes32 indexed id, uint256 pulled, uint256 owed);
    event DebtPaid(address indexed debtor, address indexed creditor, uint256 amount);

    error NotOperator();
    error NotMember();
    error AlreadyMember();
    error OnlyLower();
    error UnknownSpend();
    error SpendExists();
    error NotOpen();
    error BadSplit();
    error NotParticipant();
    error AlreadyApproved();
    error Expired();
    error NotFullyApproved();
    error TransferFailed();
    error TooMuch();
    error TicketUsed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usdc_, address operator_) {
        usdc = usdc_;
        operator = operator_;
    }

    // --- membership and limits -------------------------------------------------------------

    /// Joins a group from the member's own (passkey) wallet with a starting limit. `ticket` is the
    /// single-use id from the invite link the agent DMed them; the server watches `Joined` to link
    /// the wallet to their chat handle. Rejoining after leaving starts a fresh window.
    function join(bytes32 group, uint128 limit, Period period, bytes32 ticket) external {
        if (members[group][msg.sender].active) revert AlreadyMember();
        if (ticketUsed[ticket]) revert TicketUsed();
        ticketUsed[ticket] = true;
        members[group][msg.sender] = Member(true, period, limit, _window(period), 0);
        emit Joined(group, msg.sender, limit, period, ticket);
    }

    function leave(bytes32 group) external {
        _remove(group, msg.sender);
    }

    /// The agent removes someone who left the group chat. Only ever reduces what can be pulled.
    function removeMember(bytes32 group, address member) external onlyOperator {
        _remove(group, member);
    }

    /// The member sets their own limit in a group, up or down. Changing the period starts a fresh
    /// window.
    function setLimit(bytes32 group, uint128 limit, Period period) external {
        Member storage m = _member(group, msg.sender);
        if (m.period != period) {
            m.period = period;
            m.windowIndex = _window(period);
            m.spent = 0;
        }
        m.limit = limit;
        emit LimitSet(group, msg.sender, limit, period, msg.sender);
    }

    /// The agent relays "lower my limit" from the chat. It can never raise one.
    function lowerLimit(bytes32 group, address member, uint128 limit) external onlyOperator {
        Member storage m = _member(group, member);
        if (limit > m.limit) revert OnlyLower();
        m.limit = limit;
        emit LimitSet(group, member, limit, m.period, msg.sender);
    }

    /// What can still be pulled from `member` in `group` this period.
    function remaining(bytes32 group, address member) public view returns (uint256) {
        Member storage m = members[group][member];
        if (!m.active) return 0;
        uint256 spent = m.windowIndex == _window(m.period) ? m.spent : 0;
        return m.limit > spent ? m.limit - spent : 0;
    }

    /// Timestamp the member's current period in `group` ends.
    /// 0 for a one-time limit, which never resets.
    function resetsAt(bytes32 group, address member) external view returns (uint256) {
        Period period = members[group][member].period;
        if (period == Period.Once) return 0;
        return ANCHOR + (_window(period) + 1) * _length(period);
    }

    // --- spends ------------------------------------------------------------------------------

    /// The agent proposes a split among members of `group`. Nothing moves until every participant
    /// approves from their wallet. The payee may appear in `participants` (their own share is
    /// never pulled and needs no approval).
    function propose(
        bytes32 id,
        bytes32 group,
        address payee,
        address[] calldata participants,
        uint256[] calldata shares,
        uint64 deadline
    ) external onlyOperator {
        if (spends[id].status != Status.None) revert SpendExists();
        if (participants.length == 0 || participants.length != shares.length) revert BadSplit();
        if (deadline <= block.timestamp) revert Expired();

        uint256 total;
        uint32 needed;
        for (uint256 i; i < participants.length; ++i) {
            _member(group, participants[i]);
            for (uint256 j; j < i; ++j) {
                if (participants[j] == participants[i]) revert BadSplit();
            }
            total += shares[i];
            if (participants[i] != payee && shares[i] > 0) ++needed;
        }
        if (needed == 0) revert BadSplit();

        spends[id] =
            Spend(Status.Proposed, group, payee, deadline, needed, 0, total, participants, shares);
        emit SpendProposed(id, group, payee, total, deadline);
    }

    /// A member approves their share of a split from their own wallet.
    function approve(bytes32 id) external {
        _approve(id, msg.sender);
    }

    /// The agent relays a member's 👍 from the chat, so approving needs no Face ID. This is safe
    /// to delegate because `settle` never pulls more than the limit the member signed themselves.
    function approveFor(bytes32 id, address member) external onlyOperator {
        _approve(id, member);
    }

    /// Pulls every share to the payer. Anyone may call it once everyone has approved. A share over
    /// the member's remaining limit (including someone removed since approving), or one the token
    /// refuses, is recorded as a debt instead.
    function settle(bytes32 id) external {
        Spend storage s = _open(id);
        if (s.approvals < s.approvalsNeeded) revert NotFullyApproved();
        s.status = Status.Settled;

        uint256 pulled;
        uint256 owed;
        for (uint256 i; i < s.participants.length; ++i) {
            address from = s.participants[i];
            uint256 amount = s.shares[i];
            if (from == s.payee || amount == 0) continue;

            string memory reason;
            if (amount > remaining(s.group, from)) reason = "over limit";
            else if (!_tryTransferFrom(from, s.payee, amount)) reason = "transfer failed";

            if (bytes(reason).length == 0) {
                _spend(s.group, from, amount);
                pulled += amount;
                emit SharePulled(id, from, s.payee, amount);
            } else {
                debts[from][s.payee] += amount;
                owed += amount;
                emit PullFailed(id, from, s.payee, amount, reason);
            }
        }
        emit SpendSettled(id, pulled, owed);
    }

    function cancel(bytes32 id) external onlyOperator {
        _open(id).status = Status.Cancelled;
        emit SpendCancelled(id);
    }

    /// A debtor pays back what they owe from their own wallet.
    function payDebt(address creditor, uint256 amount) external {
        if (amount > debts[msg.sender][creditor]) revert TooMuch();
        debts[msg.sender][creditor] -= amount;
        if (!_tryTransferFrom(msg.sender, creditor, amount)) revert TransferFailed();
        emit DebtPaid(msg.sender, creditor, amount);
    }

    function getSpend(bytes32 id)
        external
        view
        returns (
            Status status,
            bytes32 group,
            address payee,
            uint256 total,
            uint64 deadline,
            uint32 approvals,
            uint32 approvalsNeeded,
            address[] memory participants,
            uint256[] memory shares
        )
    {
        Spend storage s = spends[id];
        return (
            s.status,
            s.group,
            s.payee,
            s.total,
            s.deadline,
            s.approvals,
            s.approvalsNeeded,
            s.participants,
            s.shares
        );
    }

    // --- internals ---------------------------------------------------------------------------

    function _member(bytes32 group, address who) internal view returns (Member storage m) {
        m = members[group][who];
        if (!m.active) revert NotMember();
    }

    function _approve(bytes32 id, address who) internal {
        Spend storage s = _open(id);
        if (block.timestamp > s.deadline) revert Expired();
        if (approved[id][who]) revert AlreadyApproved();
        if (!_owes(s, who)) revert NotParticipant();
        approved[id][who] = true;
        ++s.approvals;
        emit SpendApproved(id, who);
    }

    function _remove(bytes32 group, address who) internal {
        Member storage m = _member(group, who);
        m.active = false;
        m.limit = 0;
        emit Left(group, who, msg.sender);
    }

    function _open(bytes32 id) internal view returns (Spend storage s) {
        s = spends[id];
        if (s.status == Status.None) revert UnknownSpend();
        if (s.status != Status.Proposed) revert NotOpen();
    }

    function _owes(Spend storage s, address who) internal view returns (bool) {
        if (who == s.payee) return false;
        for (uint256 i; i < s.participants.length; ++i) {
            if (s.participants[i] == who) return s.shares[i] > 0;
        }
        return false;
    }

    function _spend(bytes32 group, address who, uint256 amount) internal {
        Member storage m = members[group][who];
        uint64 window = _window(m.period);
        if (m.windowIndex != window) {
            m.windowIndex = window;
            m.spent = 0;
        }
        // casting to 'uint128' is safe because amount <= remaining() <= the uint128 limit
        // forge-lint: disable-next-line(unsafe-typecast)
        m.spent += uint128(amount);
    }

    function _length(Period period) internal pure returns (uint256) {
        return period == Period.Weekly ? 7 days : MONTH;
    }

    function _window(Period period) internal view returns (uint64) {
        if (period == Period.Once) return 0;
        return uint64((block.timestamp - ANCHOR) / _length(period));
    }

    /// Never reverts: a broken or non-standard token result counts as a failed pull.
    function _tryTransferFrom(address from, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }
}
