// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title GroupTreasury
/// @notice One contract per group chat. Money stays in each member's own wallet; when a split is
/// approved by everyone in it, each share is pulled straight to whoever paid, never more than what
/// is left of that member's recurring (weekly or monthly) limit.
///
/// Trust model: the operator is the chat agent's key. It can propose splits and LOWER a member's
/// limit (a chat "lower my limit" is always safe to honour), but it can never raise a limit,
/// approve on a member's behalf, or send money anywhere except to the payee of an approved split.
/// Raising a limit and approving a split are transactions from the member's own wallet.
contract GroupTreasury {
    enum Period {
        Weekly,
        Monthly
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

    mapping(address => Member) public members;
    mapping(bytes32 => Spend) internal spends;
    mapping(bytes32 => mapping(address => bool)) public approved;
    /// debts[debtor][creditor]: shares that could not be pulled.
    mapping(address => mapping(address => uint256)) public debts;

    event Joined(address indexed member, uint256 limit, Period period);
    event Left(address indexed member);
    event LimitSet(address indexed member, uint256 limit, Period period, address indexed by);
    event SpendProposed(bytes32 indexed id, address indexed payee, uint256 total, uint64 deadline);
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

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usdc_, address operator_) {
        usdc = usdc_;
        operator = operator_;
    }

    // --- membership and limits -------------------------------------------------------------

    /// Joins from the member's own wallet with a starting limit. The wallet must also approve this
    /// contract on the USDC token; the limit here is what caps each period.
    function join(uint128 limit, Period period) external {
        if (members[msg.sender].active) revert AlreadyMember();
        members[msg.sender] = Member(true, period, limit, _window(period), 0);
        emit Joined(msg.sender, limit, period);
    }

    function leave() external {
        if (!members[msg.sender].active) revert NotMember();
        members[msg.sender].active = false;
        members[msg.sender].limit = 0;
        emit Left(msg.sender);
    }

    /// The member sets their own limit, up or down. Changing the period starts a fresh window.
    function setLimit(uint128 limit, Period period) external {
        Member storage m = _member(msg.sender);
        if (m.period != period) {
            m.period = period;
            m.windowIndex = _window(period);
            m.spent = 0;
        }
        m.limit = limit;
        emit LimitSet(msg.sender, limit, period, msg.sender);
    }

    /// The agent relays "lower my limit" from the chat. It can never raise one.
    function lowerLimit(address member, uint128 limit) external onlyOperator {
        Member storage m = _member(member);
        if (limit > m.limit) revert OnlyLower();
        m.limit = limit;
        emit LimitSet(member, limit, m.period, msg.sender);
    }

    /// What can still be pulled from `member` this period.
    function remaining(address member) public view returns (uint256) {
        Member storage m = members[member];
        if (!m.active) return 0;
        uint256 spent = m.windowIndex == _window(m.period) ? m.spent : 0;
        return m.limit > spent ? m.limit - spent : 0;
    }

    /// Timestamp the member's current period ends.
    function resetsAt(address member) external view returns (uint256) {
        uint256 len = _length(members[member].period);
        return ANCHOR + (_window(members[member].period) + 1) * len;
    }

    // --- spends ------------------------------------------------------------------------------

    /// The agent proposes a split. Nothing moves until every participant approves from their wallet.
    /// The payee may appear in `participants` (their own share is never pulled and needs no approval).
    function propose(
        bytes32 id,
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
            _member(participants[i]);
            for (uint256 j; j < i; ++j) {
                if (participants[j] == participants[i]) revert BadSplit();
            }
            total += shares[i];
            if (participants[i] != payee && shares[i] > 0) ++needed;
        }
        if (needed == 0) revert BadSplit();

        spends[id] = Spend(Status.Proposed, payee, deadline, needed, 0, total, participants, shares);
        emit SpendProposed(id, payee, total, deadline);
    }

    /// A member approves their share of a split (the onchain twin of the 👍 in the chat).
    function approve(bytes32 id) external {
        Spend storage s = _open(id);
        if (block.timestamp > s.deadline) revert Expired();
        if (approved[id][msg.sender]) revert AlreadyApproved();
        if (!_owes(s, msg.sender)) revert NotParticipant();
        approved[id][msg.sender] = true;
        ++s.approvals;
        emit SpendApproved(id, msg.sender);
    }

    /// Pulls every share to the payer. Anyone may call it once everyone has approved. A share over
    /// the member's remaining limit, or one the token refuses, is recorded as a debt instead.
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
            if (amount > remaining(from)) reason = "over limit";
            else if (!_tryTransferFrom(from, s.payee, amount)) reason = "transfer failed";

            if (bytes(reason).length == 0) {
                _spend(from, amount);
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

    function _member(address who) internal view returns (Member storage m) {
        m = members[who];
        if (!m.active) revert NotMember();
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

    function _spend(address who, uint256 amount) internal {
        Member storage m = members[who];
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
        return uint64((block.timestamp - ANCHOR) / _length(period));
    }

    /// Never reverts: a broken or non-standard token result counts as a failed pull.
    function _tryTransferFrom(address from, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }
}
