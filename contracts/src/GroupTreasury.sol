// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
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
///
/// Two things go beyond plain splits:
/// - Auto pay-back: money coming to someone who owes others goes to those people first, so debts
///   clear themselves the next time the debtor is paid back for anything (`settle`).
/// - All-or-nothing group buys (`openPool`): each pledge is held here, and the pot goes to the
///   payer only once enough people are in; otherwise everyone gets their pledge back. Held money
///   can only ever go to that payer or back to the person who pledged it.
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

    /// An all-or-nothing group buy: `needed` people each put in `each`, or nobody pays.
    /// status: Proposed = open, Settled = filled and paid out, Cancelled = refunded.
    struct Pool {
        Status status;
        bytes32 group;
        address payee;
        uint64 deadline;
        uint32 needed;
        uint128 each;
        address[] backers;
    }

    /// A single "who owes whom" edge, used to rewrite the debt graph in `netSettle`.
    struct Transfer {
        address from;
        address to;
        uint256 amount;
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
    /// Everyone `debtor` has ever owed, so money coming to them can find whom to pay back first.
    mapping(address => address[]) internal creditorsOf;
    mapping(address => mapping(address => bool)) internal isCreditor;
    mapping(bytes32 => Pool) internal pools;
    mapping(bytes32 => mapping(address => bool)) public pledged;

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
    event DebtsNetted(uint256 cleared, uint256 added);
    /// Part of a share headed to `debtor` went straight to `creditor` instead, paying back that debt.
    event DebtAutoPaid(
        bytes32 indexed id, address indexed debtor, address indexed creditor, uint256 amount
    );
    event PoolOpened(
        bytes32 indexed id,
        bytes32 indexed group,
        address indexed payee,
        uint256 each,
        uint32 needed,
        uint64 deadline
    );
    event Pledged(bytes32 indexed id, address indexed member, uint32 count);
    event PoolFilled(bytes32 indexed id, address indexed payee, uint256 total);
    event PoolRefunded(bytes32 indexed id, uint32 backers);

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
    error NotBalanced();
    error SelfDebt();
    error OverLimit();
    error AlreadyPledged();
    error NotExpired();

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
            else if (!_deliver(id, from, s.payee, amount)) reason = "transfer failed";

            if (bytes(reason).length == 0) {
                _spend(s.group, from, amount);
                pulled += amount;
                emit SharePulled(id, from, s.payee, amount);
            } else {
                _addDebt(from, s.payee, amount);
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

    /// Settle-up netting: rewrite the pairwise debt graph to an equivalent one with fewer transfers.
    /// `clears` are existing debt edges to remove; `adds` are the replacement edges (computed off
    /// chain, e.g. "A owes B, B owes C" becomes "A owes C"). The rewrite is accepted only if it
    /// leaves every touched address's net balance (what they owe minus what they're owed) exactly
    /// unchanged, so no money is created, destroyed, or shifted between people: only who-pays-whom is
    /// simplified. No money moves here; the (now fewer) debts are still paid back with `payDebt`.
    ///
    /// Operator-only, which is safe because a balance-preserving rewrite can never raise anyone's net
    /// debt or send value anywhere, it only reduces the number of pay-backs.
    function netSettle(Transfer[] calldata clears, Transfer[] calldata adds) external onlyOperator {
        uint256 cap = 2 * (clears.length + adds.length);
        address[] memory who = new address[](cap);
        int256[] memory bal = new int256[](cap);
        uint256 n;

        for (uint256 i; i < clears.length; ++i) {
            Transfer calldata c = clears[i];
            if (c.amount > debts[c.from][c.to]) revert TooMuch();
            debts[c.from][c.to] -= c.amount;
            // Removing an edge: the debtor owes less, the creditor is owed less.
            n = _accrue(who, bal, n, c.from, -int256(c.amount));
            n = _accrue(who, bal, n, c.to, int256(c.amount));
        }
        for (uint256 i; i < adds.length; ++i) {
            Transfer calldata a = adds[i];
            if (a.from == a.to) revert SelfDebt();
            _addDebt(a.from, a.to, a.amount);
            // Adding an edge: the debtor owes more, the creditor is owed more.
            n = _accrue(who, bal, n, a.from, int256(a.amount));
            n = _accrue(who, bal, n, a.to, -int256(a.amount));
        }
        for (uint256 i; i < n; ++i) {
            if (bal[i] != 0) revert NotBalanced();
        }
        emit DebtsNetted(clears.length, adds.length);
    }

    // --- all-or-nothing group buys -----------------------------------------------------------

    /// The agent opens a group buy: `needed` members of `group` each put in `each` for `payee`
    /// (whoever buys the thing) before `deadline`, or nobody pays.
    function openPool(
        bytes32 id,
        bytes32 group,
        address payee,
        uint128 each,
        uint32 needed,
        uint64 deadline
    ) external onlyOperator {
        if (pools[id].status != Status.None) revert SpendExists();
        if (each == 0 || needed == 0) revert BadSplit();
        if (deadline <= block.timestamp) revert Expired();
        _member(group, payee);
        Pool storage p = pools[id];
        p.status = Status.Proposed;
        p.group = group;
        p.payee = payee;
        p.deadline = deadline;
        p.needed = needed;
        p.each = each;
        emit PoolOpened(id, group, payee, each, needed, deadline);
    }

    /// A member pledges from their own wallet.
    function pledge(bytes32 id) external {
        _pledge(id, msg.sender);
    }

    /// The agent relays a member's 👍. Safe for the same reason as `approveFor`: the pledge is capped
    /// by the member's own limit, and held money only goes to the payee or back to them.
    function pledgeFor(bytes32 id, address member) external onlyOperator {
        _pledge(id, member);
    }

    /// Gives everyone their pledge back (and their limit) once the deadline passed without enough
    /// people. Anyone can call it then; the agent can also call a buy off early.
    function refundPool(bytes32 id) external {
        Pool storage p = _openPool(id);
        if (block.timestamp <= p.deadline && msg.sender != operator) revert NotExpired();
        p.status = Status.Cancelled;
        for (uint256 i; i < p.backers.length; ++i) {
            address b = p.backers[i];
            _unspend(p.group, b, p.each);
            _send(b, p.each);
        }
        // casting is safe: backers.length <= needed, a uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        emit PoolRefunded(id, uint32(p.backers.length));
    }

    function getPool(bytes32 id)
        external
        view
        returns (
            Status status,
            bytes32 group,
            address payee,
            uint256 each,
            uint32 needed,
            uint64 deadline,
            address[] memory backers
        )
    {
        Pool storage p = pools[id];
        return (p.status, p.group, p.payee, p.each, p.needed, p.deadline, p.backers);
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

    /// Add `d` to the running net-balance delta for address `a` in the (who, bal) scratch arrays,
    /// appending a new slot the first time an address is seen. Returns the new entry count.
    function _accrue(address[] memory who, int256[] memory bal, uint256 n, address a, int256 d)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < n; ++i) {
            if (who[i] == a) {
                bal[i] += d;
                return n;
            }
        }
        who[n] = a;
        bal[n] = d;
        return n + 1;
    }

    function _pledge(bytes32 id, address who) internal {
        Pool storage p = _openPool(id);
        if (block.timestamp > p.deadline) revert Expired();
        _member(p.group, who);
        if (pledged[id][who]) revert AlreadyPledged();
        if (p.each > remaining(p.group, who)) revert OverLimit();
        if (!_tryTransferFrom(who, address(this), p.each)) revert TransferFailed();
        pledged[id][who] = true;
        _spend(p.group, who, p.each);
        p.backers.push(who);
        // casting is safe: one pledge per address and the pool closes at `needed` (a uint32)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 count = uint32(p.backers.length);
        emit Pledged(id, who, count);
        if (count == p.needed) {
            p.status = Status.Settled;
            uint256 total = uint256(p.each) * count;
            _send(p.payee, total);
            emit PoolFilled(id, p.payee, total);
        }
    }

    function _openPool(bytes32 id) internal view returns (Pool storage p) {
        p = pools[id];
        if (p.status == Status.None) revert UnknownSpend();
        if (p.status != Status.Proposed) revert NotOpen();
    }

    /// Gives back limit used by money that came back (a refunded pledge), within the same period.
    function _unspend(bytes32 group, address who, uint256 amount) internal {
        Member storage m = members[group][who];
        if (m.windowIndex != _window(m.period)) return;
        // casting is safe: amount was added to `spent` as a uint128 by `_spend`
        // forge-lint: disable-next-line(unsafe-typecast)
        m.spent = m.spent > amount ? m.spent - uint128(amount) : 0;
    }

    function _addDebt(address debtor, address creditor, uint256 amount) internal {
        debts[debtor][creditor] += amount;
        if (!isCreditor[debtor][creditor]) {
            isCreditor[debtor][creditor] = true;
            creditorsOf[debtor].push(creditor);
        }
    }

    /// Moves `amount` from `from` to `payee`, except that whatever `payee` owes other people is paid
    /// to them first (auto pay-back). One pull either way, so it all moves or nothing does. False if
    /// the token refuses the pull. The share's own sender is skipped as a creditor: paying someone
    /// back with their own money is better handled by netting.
    function _deliver(bytes32 id, address from, address payee, uint256 amount)
        internal
        returns (bool)
    {
        address[] storage cs = creditorsOf[payee];
        bool owes;
        for (uint256 i; i < cs.length && !owes; ++i) {
            owes = cs[i] != from && debts[payee][cs[i]] > 0;
        }
        if (!owes) return _tryTransferFrom(from, payee, amount);

        if (!_tryTransferFrom(from, address(this), amount)) return false;
        uint256 left = amount;
        for (uint256 i; i < cs.length && left > 0; ++i) {
            address c = cs[i];
            uint256 d = debts[payee][c];
            if (c == from || d == 0) continue;
            uint256 x = d < left ? d : left;
            debts[payee][c] = d - x;
            left -= x;
            _send(c, x);
            emit DebtAutoPaid(id, payee, c, x);
        }
        if (left > 0) _send(payee, left);
        return true;
    }

    /// Pays out money this contract holds. Reverts if the token refuses: held money must never be
    /// lost or stuck half-sent.
    function _send(address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && (data.length < 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed();
        }
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
