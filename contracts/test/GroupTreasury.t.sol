// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {GroupTreasury, IERC20} from "../src/GroupTreasury.sol";

/// Minimal 6-decimal USDC stand-in.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract GroupTreasuryTest is Test {
    uint128 constant USD = 1e6;

    MockUSDC usdc;
    GroupTreasury treasury;
    address operator = makeAddr("operator");
    address neena = makeAddr("neena");
    address siya = makeAddr("siya");
    address tristan = makeAddr("tristan");
    address stranger = makeAddr("stranger");
    bytes32 constant ID = keccak256("dinner");
    bytes32 constant G = keccak256("chat:roommates");
    bytes32 constant TRIP = keccak256("chat:trip");

    function setUp() public {
        vm.warp(1_763_337_600); // Mon 17 Nov 2025 00:00 UTC, a week boundary
        usdc = new MockUSDC();
        treasury = new GroupTreasury(IERC20(address(usdc)), operator);
        _join(neena, 50 * USD);
        _join(siya, 50 * USD);
        _join(tristan, 50 * USD);
    }

    uint256 tickets;

    function _t() internal returns (bytes32) {
        return keccak256(abi.encode("ticket", ++tickets));
    }

    function _join(address who, uint128 limit) internal {
        usdc.mint(who, 1_000 * USD);
        vm.startPrank(who);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.join(G, limit, GroupTreasury.Period.Weekly, _t());
        vm.stopPrank();
    }

    /// Neena paid 90 for dinner; Siya and Tristan owe 30 each.
    function _proposeDinner() internal {
        address[] memory who = new address[](3);
        (who[0], who[1], who[2]) = (neena, siya, tristan);
        uint256[] memory shares = new uint256[](3);
        (shares[0], shares[1], shares[2]) = (30 * USD, 30 * USD, 30 * USD);
        vm.prank(operator);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1 days));
    }

    function _approveAll() internal {
        vm.prank(siya);
        treasury.approve(ID);
        vm.prank(tristan);
        treasury.approve(ID);
    }

    // --- join / leave ---

    function test_join_setsLimit() public view {
        assertEq(treasury.remaining(G, neena), 50 * USD);
    }

    function test_join_revertsTwice() public {
        vm.prank(neena);
        vm.expectRevert(GroupTreasury.AlreadyMember.selector);
        treasury.join(G, 1, GroupTreasury.Period.Weekly, _t());
    }

    function test_leave_zeroesRemaining() public {
        vm.prank(neena);
        treasury.leave(G);
        assertEq(treasury.remaining(G, neena), 0);
    }

    function test_leave_revertsForNonMember() public {
        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.leave(G);
    }

    // --- limits ---

    function test_setLimit_memberCanRaise() public {
        vm.prank(neena);
        treasury.setLimit(G, 500 * USD, GroupTreasury.Period.Weekly);
        assertEq(treasury.remaining(G, neena), 500 * USD);
    }

    function test_setLimit_revertsForNonMember() public {
        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.setLimit(G, 1, GroupTreasury.Period.Weekly);
    }

    function test_setLimit_periodChangeStartsFreshWindow() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(G, siya), 20 * USD);
        vm.prank(siya);
        treasury.setLimit(G, 50 * USD, GroupTreasury.Period.Monthly);
        assertEq(treasury.remaining(G, siya), 50 * USD);
    }

    function test_lowerLimit_operatorCanLower() public {
        vm.prank(operator);
        treasury.lowerLimit(G, neena, 10 * USD);
        assertEq(treasury.remaining(G, neena), 10 * USD);
    }

    function test_lowerLimit_operatorCannotRaise() public {
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.OnlyLower.selector);
        treasury.lowerLimit(G, neena, 51 * USD);
    }

    function test_lowerLimit_revertsForNonOperator() public {
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.lowerLimit(G, neena, 0);
    }

    function test_lowerLimit_revertsForNonMember() public {
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.lowerLimit(G, stranger, 0);
    }

    function test_limit_resetsNextWeek() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(G, siya), 20 * USD);
        vm.warp(block.timestamp + 7 days);
        assertEq(treasury.remaining(G, siya), 50 * USD);
        assertEq(treasury.resetsAt(G, siya), block.timestamp + 7 days);
    }

    // --- one-time limits (trips) ---

    function _switchToOnce(address who, uint128 limit) internal {
        vm.prank(who);
        treasury.setLimit(G, limit, GroupTreasury.Period.Once);
    }

    function test_once_neverRefills() public {
        _switchToOnce(siya, 50 * USD);
        _switchToOnce(tristan, 50 * USD);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(G, siya), 20 * USD);
        vm.warp(block.timestamp + 400 days);
        assertEq(treasury.remaining(G, siya), 20 * USD);
        assertEq(treasury.resetsAt(G, siya), 0);
    }

    function test_once_raiseKeepsWhatWasSpent() public {
        _switchToOnce(siya, 50 * USD);
        _switchToOnce(tristan, 50 * USD);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        _switchToOnce(siya, 80 * USD); // a top-up for the rest of the trip
        assertEq(treasury.remaining(G, siya), 50 * USD);
    }

    function test_once_capsPullsAtTheLimit() public {
        _switchToOnce(siya, 20 * USD); // her 30 share is over the trip limit
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(usdc.balanceOf(siya), 1_000 * USD);
        assertEq(treasury.debts(siya, neena), 30 * USD);
    }

    function test_once_joinWithOneTimeLimit() public {
        address dana = makeAddr("dana");
        usdc.mint(dana, 1_000 * USD);
        vm.startPrank(dana);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.join(TRIP, 200 * USD, GroupTreasury.Period.Once, _t());
        vm.stopPrank();
        (bool active, GroupTreasury.Period period, uint128 limit,,) = treasury.members(TRIP, dana);
        assertTrue(active);
        assertEq(uint8(period), uint8(GroupTreasury.Period.Once));
        assertEq(limit, 200 * USD);
    }

    function test_once_operatorCanOnlyLower() public {
        _switchToOnce(siya, 50 * USD);
        vm.startPrank(operator);
        treasury.lowerLimit(G, siya, 10 * USD);
        vm.expectRevert(GroupTreasury.OnlyLower.selector);
        treasury.lowerLimit(G, siya, 60 * USD);
        vm.stopPrank();
        assertEq(treasury.remaining(G, siya), 10 * USD);
    }

    // --- propose ---

    function test_propose_revertsForNonOperator() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.propose(ID, G, siya, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsForNonMemberParticipant() public {
        address[] memory who = new address[](1);
        who[0] = stranger;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnDuplicateParticipant() public {
        address[] memory who = new address[](2);
        (who[0], who[1]) = (siya, siya);
        uint256[] memory shares = new uint256[](2);
        (shares[0], shares[1]) = (USD, USD);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnLengthMismatch() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](0);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsWhenOnlyPayeeOwes() public {
        address[] memory who = new address[](1);
        who[0] = neena;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnPastDeadline() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.Expired.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp));
    }

    function test_propose_revertsOnReusedId() public {
        _proposeDinner();
        vm.expectRevert(GroupTreasury.SpendExists.selector);
        _proposeDinner();
    }

    // --- approve ---

    function test_approve_countsParticipants() public {
        _proposeDinner();
        vm.prank(siya);
        treasury.approve(ID);
        (,,,,, uint32 approvals, uint32 needed,,) = treasury.getSpend(ID);
        assertEq(approvals, 1);
        assertEq(needed, 2);
    }

    function test_approve_revertsForOutsider() public {
        _proposeDinner();
        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotParticipant.selector);
        treasury.approve(ID);
    }

    function test_approve_revertsForPayee() public {
        _proposeDinner();
        vm.prank(neena);
        vm.expectRevert(GroupTreasury.NotParticipant.selector);
        treasury.approve(ID);
    }

    function test_approve_revertsTwice() public {
        _proposeDinner();
        vm.startPrank(siya);
        treasury.approve(ID);
        vm.expectRevert(GroupTreasury.AlreadyApproved.selector);
        treasury.approve(ID);
        vm.stopPrank();
    }

    function test_approve_revertsAfterDeadline() public {
        _proposeDinner();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.Expired.selector);
        treasury.approve(ID);
    }

    function test_approve_revertsForUnknownSpend() public {
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.UnknownSpend.selector);
        treasury.approve(ID);
    }

    // --- settle ---

    function test_settle_pullsEachShareToPayee() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(usdc.balanceOf(neena), 1_060 * USD);
        assertEq(usdc.balanceOf(siya), 970 * USD);
        assertEq(usdc.balanceOf(tristan), 970 * USD);
        assertEq(treasury.remaining(G, neena), 50 * USD); // payee's own share never counts
    }

    function test_settle_revertsUntilEveryoneApproves() public {
        _proposeDinner();
        vm.prank(siya);
        treasury.approve(ID);
        vm.expectRevert(GroupTreasury.NotFullyApproved.selector);
        treasury.settle(ID);
    }

    function test_settle_revertsTwice() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        vm.expectRevert(GroupTreasury.NotOpen.selector);
        treasury.settle(ID);
    }

    function test_settle_overLimitBecomesDebt() public {
        vm.prank(operator);
        treasury.lowerLimit(G, tristan, 10 * USD);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(usdc.balanceOf(tristan), 1_000 * USD);
        assertEq(treasury.debts(tristan, neena), 30 * USD);
        assertEq(usdc.balanceOf(neena), 1_030 * USD);
    }

    function test_settle_revokedAllowanceBecomesDebt() public {
        vm.prank(siya);
        usdc.approve(address(treasury), 0);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.debts(siya, neena), 30 * USD);
        assertEq(treasury.remaining(G, siya), 50 * USD); // a failed pull doesn't use the limit
    }

    // --- cancel ---

    function test_cancel_blocksApproveAndSettle() public {
        _proposeDinner();
        vm.prank(operator);
        treasury.cancel(ID);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOpen.selector);
        treasury.approve(ID);
    }

    function test_cancel_revertsForNonOperator() public {
        _proposeDinner();
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.cancel(ID);
    }

    // --- debts ---

    function test_payDebt_clearsDebt() public {
        vm.prank(operator);
        treasury.lowerLimit(G, tristan, 0);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        vm.prank(tristan);
        treasury.payDebt(neena, 30 * USD);
        assertEq(treasury.debts(tristan, neena), 0);
        assertEq(usdc.balanceOf(neena), 1_060 * USD);
    }

    function test_payDebt_revertsOverOwed() public {
        vm.prank(tristan);
        vm.expectRevert(GroupTreasury.TooMuch.selector);
        treasury.payDebt(neena, 1);
    }

    function test_payDebt_revertsWhenTransferFails() public {
        vm.prank(operator);
        treasury.lowerLimit(G, tristan, 0);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        vm.startPrank(tristan);
        usdc.approve(address(treasury), 0);
        vm.expectRevert(GroupTreasury.TransferFailed.selector);
        treasury.payDebt(neena, 30 * USD);
        vm.stopPrank();
    }

    // --- netSettle (settle-up netting) ---

    /// Record a debtor->creditor debt of `amount` by settling a 2-person spend the debtor can't cover.
    function _debt(address debtor, address creditor, uint128 amount, bytes32 id) internal {
        vm.prank(operator);
        treasury.lowerLimit(G, debtor, 0); // remaining 0, so the debtor's share becomes a debt
        address[] memory who = new address[](2);
        (who[0], who[1]) = (creditor, debtor);
        uint256[] memory shares = new uint256[](2);
        (shares[0], shares[1]) = (0, amount);
        vm.prank(operator);
        treasury.propose(id, G, creditor, who, shares, uint64(block.timestamp + 1 days));
        vm.prank(debtor);
        treasury.approve(id);
        treasury.settle(id);
        assertEq(treasury.debts(debtor, creditor), amount);
    }

    function _edge(address from, address to, uint256 amount)
        internal
        pure
        returns (GroupTreasury.Transfer memory)
    {
        return GroupTreasury.Transfer(from, to, amount);
    }

    function test_netSettle_collapsesAChain() public {
        _debt(neena, tristan, 12 * USD, keccak256("d1")); // neena -> tristan
        _debt(tristan, siya, 12 * USD, keccak256("d2")); // tristan -> siya

        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](2);
        clears[0] = _edge(neena, tristan, 12 * USD);
        clears[1] = _edge(tristan, siya, 12 * USD);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](1);
        adds[0] = _edge(neena, siya, 12 * USD);

        vm.expectEmit(false, false, false, true);
        emit GroupTreasury.DebtsNetted(2, 1);
        vm.prank(operator);
        treasury.netSettle(clears, adds);

        assertEq(treasury.debts(neena, tristan), 0);
        assertEq(treasury.debts(tristan, siya), 0);
        assertEq(treasury.debts(neena, siya), 12 * USD); // one transfer instead of two
    }

    function test_netSettle_mutualDebtsCancel() public {
        _debt(neena, siya, 10 * USD, keccak256("m1"));
        _debt(siya, neena, 10 * USD, keccak256("m2"));

        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](2);
        clears[0] = _edge(neena, siya, 10 * USD);
        clears[1] = _edge(siya, neena, 10 * USD);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](0);

        vm.prank(operator);
        treasury.netSettle(clears, adds);

        assertEq(treasury.debts(neena, siya), 0);
        assertEq(treasury.debts(siya, neena), 0);
    }

    function test_netSettle_thenPayDebtSettlesInOneTransfer() public {
        _debt(neena, tristan, 12 * USD, keccak256("d1"));
        _debt(tristan, siya, 12 * USD, keccak256("d2"));

        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](2);
        clears[0] = _edge(neena, tristan, 12 * USD);
        clears[1] = _edge(tristan, siya, 12 * USD);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](1);
        adds[0] = _edge(neena, siya, 12 * USD);
        vm.prank(operator);
        treasury.netSettle(clears, adds);

        // The single netted debt is payable the normal way, and Tristan (the middleman) owes nothing.
        vm.prank(neena);
        treasury.payDebt(siya, 12 * USD);
        assertEq(treasury.debts(neena, siya), 0);
        assertEq(usdc.balanceOf(siya), 1_012 * USD); // Siya paid directly by Neena
        assertEq(usdc.balanceOf(neena), 988 * USD);
        assertEq(usdc.balanceOf(tristan), 1_000 * USD); // never had to front or forward anything
    }

    function test_netSettle_revertsWhenNotBalanced() public {
        _debt(neena, tristan, 12 * USD, keccak256("d1"));
        // Redirect Neena's debt to Siya without clearing Tristan's side: Tristan would be shorted.
        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](1);
        clears[0] = _edge(neena, tristan, 12 * USD);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](1);
        adds[0] = _edge(neena, siya, 12 * USD);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotBalanced.selector);
        treasury.netSettle(clears, adds);
    }

    function test_netSettle_revertsOnDebtFromNothing() public {
        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](0);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](1);
        adds[0] = _edge(neena, siya, 5 * USD); // conjures a debt that doesn't net to zero
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotBalanced.selector);
        treasury.netSettle(clears, adds);
    }

    function test_netSettle_revertsOnOverClear() public {
        _debt(neena, tristan, 12 * USD, keccak256("d1"));
        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](1);
        clears[0] = _edge(neena, tristan, 20 * USD); // more than owed
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](0);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.TooMuch.selector);
        treasury.netSettle(clears, adds);
    }

    function test_netSettle_revertsOnSelfEdge() public {
        GroupTreasury.Transfer[] memory clears = new GroupTreasury.Transfer[](0);
        GroupTreasury.Transfer[] memory adds = new GroupTreasury.Transfer[](1);
        adds[0] = _edge(neena, neena, 5 * USD);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.SelfDebt.selector);
        treasury.netSettle(clears, adds);
    }

    function test_netSettle_revertsForNonOperator() public {
        GroupTreasury.Transfer[] memory empty = new GroupTreasury.Transfer[](0);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.netSettle(empty, empty);
    }

    // --- groups change over time ---

    function test_removeMember_operatorRemovesSomeoneWhoLeftTheChat() public {
        vm.prank(operator);
        treasury.removeMember(G, tristan);
        assertEq(treasury.remaining(G, tristan), 0);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        _proposeDinner();
    }

    function test_removeMember_revertsForNonOperator() public {
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.removeMember(G, tristan);
    }

    function test_removeMember_revertsForNonMember() public {
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.removeMember(G, stranger);
    }

    function test_removeMember_afterApprovalBecomesDebt() public {
        _proposeDinner();
        _approveAll();
        vm.prank(operator);
        treasury.removeMember(G, tristan);
        treasury.settle(ID);
        assertEq(treasury.debts(tristan, neena), 30 * USD);
        assertEq(usdc.balanceOf(tristan), 1_000 * USD);
    }

    function test_join_canRejoinAfterLeaving() public {
        vm.startPrank(neena);
        treasury.leave(G);
        treasury.join(G, 5 * USD, GroupTreasury.Period.Monthly, _t());
        vm.stopPrank();
        assertEq(treasury.remaining(G, neena), 5 * USD);
    }

    function test_groups_haveSeparateMembersAndLimits() public {
        vm.prank(siya);
        treasury.join(TRIP, 300 * USD, GroupTreasury.Period.Monthly, _t());
        assertEq(treasury.remaining(TRIP, siya), 300 * USD);
        assertEq(treasury.remaining(TRIP, neena), 0); // not in the trip chat

        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(G, siya), 20 * USD);
        assertEq(treasury.remaining(TRIP, siya), 300 * USD); // roommates spend doesn't touch trip
    }

    function test_propose_revertsForMemberOfAnotherGroup() public {
        vm.prank(stranger);
        treasury.join(TRIP, 100 * USD, GroupTreasury.Period.Weekly, _t());
        address[] memory who = new address[](1);
        who[0] = stranger;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.propose(ID, G, neena, who, shares, uint64(block.timestamp + 1));
    }

    // --- invite tickets ---

    function test_join_ticketIsSingleUse() public {
        bytes32 ticket = keccak256("invite");
        vm.prank(stranger);
        treasury.join(TRIP, USD, GroupTreasury.Period.Weekly, ticket);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.TicketUsed.selector);
        treasury.join(TRIP, USD, GroupTreasury.Period.Weekly, ticket);
    }

    function test_join_emitsTicket() public {
        bytes32 ticket = keccak256("invite");
        vm.expectEmit(address(treasury));
        emit GroupTreasury.Joined(TRIP, stranger, USD, GroupTreasury.Period.Weekly, ticket);
        vm.prank(stranger);
        treasury.join(TRIP, USD, GroupTreasury.Period.Weekly, ticket);
    }

    // --- relayed 👍 ---

    function test_approveFor_operatorRelaysThumbsUp() public {
        _proposeDinner();
        vm.startPrank(operator);
        treasury.approveFor(ID, siya);
        treasury.approveFor(ID, tristan);
        vm.stopPrank();
        treasury.settle(ID);
        assertEq(usdc.balanceOf(neena), 1_060 * USD);
    }

    function test_approveFor_revertsForNonOperator() public {
        _proposeDinner();
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.approveFor(ID, tristan);
    }

    function test_approveFor_revertsForOutsider() public {
        _proposeDinner();
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotParticipant.selector);
        treasury.approveFor(ID, stranger);
    }

    function test_approveFor_revertsAfterMemberApproved() public {
        _proposeDinner();
        vm.prank(siya);
        treasury.approve(ID);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.AlreadyApproved.selector);
        treasury.approveFor(ID, siya);
    }

    // --- the headline safety property ---

    /// However the agent is prompted, the operator key alone can never take more from a member
    /// than what's left of the limit the member signed for that group.
    function testFuzz_operatorAloneIsCappedBySignedLimit(uint256 amount) public {
        amount = bound(amount, 1, 1_000 * USD);
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = amount;
        vm.startPrank(operator);
        treasury.propose(ID, G, operator, who, shares, uint64(block.timestamp + 1 days));
        treasury.approveFor(ID, siya);
        vm.stopPrank();
        treasury.settle(ID);
        assertLe(usdc.balanceOf(operator), 50 * USD);
        assertGe(usdc.balanceOf(siya), 950 * USD);
    }

    // --- auto pay-back ---

    /// Makes `debtor` owe `creditor` `amount` through a split that goes over the debtor's limit.
    function _owe(address debtor, address creditor, uint256 amount, bytes32 id) internal {
        vm.prank(operator);
        treasury.lowerLimit(G, debtor, 0);
        _split(id, creditor, debtor, amount);
        assertEq(treasury.debts(debtor, creditor), amount);
        vm.prank(debtor);
        treasury.setLimit(G, 50 * USD, GroupTreasury.Period.Weekly);
    }

    /// A one-person split: `from` owes `payee` `amount`, approved and settled.
    function _split(bytes32 id, address payee, address from, uint256 amount) internal {
        _proposeOne(id, payee, from, amount);
        treasury.settle(id);
    }

    function _proposeOne(bytes32 id, address payee, address from, uint256 amount) internal {
        address[] memory who = new address[](1);
        who[0] = from;
        uint256[] memory shares = new uint256[](1);
        shares[0] = amount;
        vm.startPrank(operator);
        treasury.propose(id, G, payee, who, shares, uint64(block.timestamp + 1 days));
        treasury.approveFor(id, from);
        vm.stopPrank();
    }

    function test_autoPayBack_shareToADebtorPaysTheirCreditorFirst() public {
        _owe(siya, neena, 20 * USD, keccak256("old"));
        uint256 neenaBefore = usdc.balanceOf(neena);
        uint256 siyaBefore = usdc.balanceOf(siya);

        // Tristan owes Siya 30: 20 goes to Neena (Siya's debt), 10 to Siya.
        _proposeOne(keccak256("pizza"), siya, tristan, 30 * USD);
        vm.expectEmit(address(treasury));
        emit GroupTreasury.DebtAutoPaid(keccak256("pizza"), siya, neena, 20 * USD);
        treasury.settle(keccak256("pizza"));

        assertEq(treasury.debts(siya, neena), 0);
        assertEq(usdc.balanceOf(neena) - neenaBefore, 20 * USD);
        assertEq(usdc.balanceOf(siya) - siyaBefore, 10 * USD);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.remaining(G, tristan), 20 * USD);
    }

    function test_autoPayBack_partialWhenShareIsSmallerThanDebt() public {
        _owe(siya, neena, 40 * USD, keccak256("old"));
        uint256 siyaBefore = usdc.balanceOf(siya);
        _split(keccak256("pizza"), siya, tristan, 15 * USD);
        assertEq(treasury.debts(siya, neena), 25 * USD);
        assertEq(usdc.balanceOf(siya), siyaBefore);
    }

    function test_autoPayBack_skipsTheSharesOwnSender() public {
        // Siya owes Tristan; Tristan paying Siya is not used to pay Tristan back (netting does that).
        _owe(siya, tristan, 20 * USD, keccak256("old"));
        uint256 siyaBefore = usdc.balanceOf(siya);
        _split(keccak256("pizza"), siya, tristan, 30 * USD);
        assertEq(treasury.debts(siya, tristan), 20 * USD);
        assertEq(usdc.balanceOf(siya) - siyaBefore, 30 * USD);
    }

    function test_autoPayBack_failedPullMovesNothing() public {
        _owe(siya, neena, 20 * USD, keccak256("old"));
        vm.prank(tristan);
        usdc.approve(address(treasury), 0);
        _split(keccak256("pizza"), siya, tristan, 30 * USD);
        assertEq(treasury.debts(siya, neena), 20 * USD);
        assertEq(treasury.debts(tristan, siya), 30 * USD);
    }

    // --- all-or-nothing group buys ---

    bytes32 constant POOL = keccak256("tickets");

    function _openPool(uint32 needed) internal {
        vm.prank(operator);
        treasury.openPool(POOL, G, neena, 40 * USD, needed, uint64(block.timestamp + 1 days));
    }

    function test_pool_paysThePayeeTheMomentItFills() public {
        _openPool(2);
        uint256 neenaBefore = usdc.balanceOf(neena);
        vm.prank(siya);
        treasury.pledge(POOL);
        assertEq(usdc.balanceOf(address(treasury)), 40 * USD);
        assertEq(usdc.balanceOf(neena), neenaBefore);

        vm.expectEmit(address(treasury));
        emit GroupTreasury.PoolFilled(POOL, neena, 80 * USD);
        vm.prank(operator);
        treasury.pledgeFor(POOL, tristan);

        assertEq(usdc.balanceOf(neena) - neenaBefore, 80 * USD);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.remaining(G, siya), 10 * USD);
        (GroupTreasury.Status status,,,,,, address[] memory backers) = treasury.getPool(POOL);
        assertEq(uint8(status), uint8(GroupTreasury.Status.Settled));
        assertEq(backers.length, 2);

        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotOpen.selector);
        treasury.pledgeFor(POOL, neena);
    }

    function test_pool_refundsEveryoneAndTheirLimitAfterTheDeadline() public {
        _openPool(3);
        vm.prank(siya);
        treasury.pledge(POOL);
        uint256 siyaBefore = usdc.balanceOf(siya);

        vm.expectRevert(GroupTreasury.NotExpired.selector);
        treasury.refundPool(POOL);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(tristan);
        vm.expectRevert(GroupTreasury.Expired.selector);
        treasury.pledge(POOL);

        vm.prank(stranger);
        treasury.refundPool(POOL);
        assertEq(usdc.balanceOf(siya) - siyaBefore, 40 * USD);
        assertEq(treasury.remaining(G, siya), 50 * USD);
        assertEq(usdc.balanceOf(address(treasury)), 0);
    }

    function test_pool_operatorCanCallItOffEarly() public {
        _openPool(3);
        vm.prank(siya);
        treasury.pledge(POOL);
        vm.prank(operator);
        treasury.refundPool(POOL);
        assertEq(treasury.remaining(G, siya), 50 * USD);
        vm.expectRevert(GroupTreasury.NotOpen.selector);
        treasury.refundPool(POOL);
    }

    function test_pool_pledgeRevertsOverLimitTwiceOrForNonMembers() public {
        _openPool(3);
        vm.prank(operator);
        treasury.lowerLimit(G, siya, 30 * USD);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.OverLimit.selector);
        treasury.pledge(POOL);

        vm.prank(tristan);
        treasury.pledge(POOL);
        vm.prank(tristan);
        vm.expectRevert(GroupTreasury.AlreadyPledged.selector);
        treasury.pledge(POOL);

        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.pledge(POOL);
    }

    function test_pool_pledgeRevertsWhenTheTokenRefuses() public {
        _openPool(3);
        vm.prank(siya);
        usdc.approve(address(treasury), 0);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.TransferFailed.selector);
        treasury.pledge(POOL);
    }

    function test_pool_onlyOperatorOpensOrPledgesForOthers() public {
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.openPool(POOL, G, neena, 40 * USD, 2, uint64(block.timestamp + 1 days));
        _openPool(2);
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.pledgeFor(POOL, tristan);
    }

    function test_pool_openRevertsOnBadInput() public {
        vm.startPrank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.openPool(POOL, G, neena, 0, 2, uint64(block.timestamp + 1 days));
        vm.expectRevert(GroupTreasury.Expired.selector);
        treasury.openPool(POOL, G, neena, 1, 2, uint64(block.timestamp));
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.openPool(POOL, G, stranger, 1, 2, uint64(block.timestamp + 1 days));
        treasury.openPool(POOL, G, neena, 1, 2, uint64(block.timestamp + 1 days));
        vm.expectRevert(GroupTreasury.SpendExists.selector);
        treasury.openPool(POOL, G, neena, 1, 2, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }
}
