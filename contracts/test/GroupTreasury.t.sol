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

    function setUp() public {
        vm.warp(1_763_337_600); // Mon 17 Nov 2025 00:00 UTC, a week boundary
        usdc = new MockUSDC();
        treasury = new GroupTreasury(IERC20(address(usdc)), operator);
        _join(neena, 50 * USD);
        _join(siya, 50 * USD);
        _join(tristan, 50 * USD);
    }

    function _join(address who, uint128 limit) internal {
        usdc.mint(who, 1_000 * USD);
        vm.startPrank(who);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.join(limit, GroupTreasury.Period.Weekly);
        vm.stopPrank();
    }

    /// Neena paid 90 for dinner; Siya and Tristan owe 30 each.
    function _proposeDinner() internal {
        address[] memory who = new address[](3);
        (who[0], who[1], who[2]) = (neena, siya, tristan);
        uint256[] memory shares = new uint256[](3);
        (shares[0], shares[1], shares[2]) = (30 * USD, 30 * USD, 30 * USD);
        vm.prank(operator);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp + 1 days));
    }

    function _approveAll() internal {
        vm.prank(siya);
        treasury.approve(ID);
        vm.prank(tristan);
        treasury.approve(ID);
    }

    // --- join / leave ---

    function test_join_setsLimit() public view {
        assertEq(treasury.remaining(neena), 50 * USD);
    }

    function test_join_revertsTwice() public {
        vm.prank(neena);
        vm.expectRevert(GroupTreasury.AlreadyMember.selector);
        treasury.join(1, GroupTreasury.Period.Weekly);
    }

    function test_leave_zeroesRemaining() public {
        vm.prank(neena);
        treasury.leave();
        assertEq(treasury.remaining(neena), 0);
    }

    function test_leave_revertsForNonMember() public {
        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.leave();
    }

    // --- limits ---

    function test_setLimit_memberCanRaise() public {
        vm.prank(neena);
        treasury.setLimit(500 * USD, GroupTreasury.Period.Weekly);
        assertEq(treasury.remaining(neena), 500 * USD);
    }

    function test_setLimit_revertsForNonMember() public {
        vm.prank(stranger);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.setLimit(1, GroupTreasury.Period.Weekly);
    }

    function test_setLimit_periodChangeStartsFreshWindow() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(siya), 20 * USD);
        vm.prank(siya);
        treasury.setLimit(50 * USD, GroupTreasury.Period.Monthly);
        assertEq(treasury.remaining(siya), 50 * USD);
    }

    function test_lowerLimit_operatorCanLower() public {
        vm.prank(operator);
        treasury.lowerLimit(neena, 10 * USD);
        assertEq(treasury.remaining(neena), 10 * USD);
    }

    function test_lowerLimit_operatorCannotRaise() public {
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.OnlyLower.selector);
        treasury.lowerLimit(neena, 51 * USD);
    }

    function test_lowerLimit_revertsForNonOperator() public {
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.lowerLimit(neena, 0);
    }

    function test_lowerLimit_revertsForNonMember() public {
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.lowerLimit(stranger, 0);
    }

    function test_limit_resetsNextWeek() public {
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        assertEq(treasury.remaining(siya), 20 * USD);
        vm.warp(block.timestamp + 7 days);
        assertEq(treasury.remaining(siya), 50 * USD);
        assertEq(treasury.resetsAt(siya), block.timestamp + 7 days);
    }

    // --- propose ---

    function test_propose_revertsForNonOperator() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(siya);
        vm.expectRevert(GroupTreasury.NotOperator.selector);
        treasury.propose(ID, siya, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsForNonMemberParticipant() public {
        address[] memory who = new address[](1);
        who[0] = stranger;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.NotMember.selector);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnDuplicateParticipant() public {
        address[] memory who = new address[](2);
        (who[0], who[1]) = (siya, siya);
        uint256[] memory shares = new uint256[](2);
        (shares[0], shares[1]) = (USD, USD);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnLengthMismatch() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](0);
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsWhenOnlyPayeeOwes() public {
        address[] memory who = new address[](1);
        who[0] = neena;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.BadSplit.selector);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp + 1));
    }

    function test_propose_revertsOnPastDeadline() public {
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = USD;
        vm.prank(operator);
        vm.expectRevert(GroupTreasury.Expired.selector);
        treasury.propose(ID, neena, who, shares, uint64(block.timestamp));
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
        (,,,, uint32 approvals, uint32 needed,,) = treasury.getSpend(ID);
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
        assertEq(treasury.remaining(neena), 50 * USD); // payee's own share never counts
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
        treasury.lowerLimit(tristan, 10 * USD);
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
        assertEq(treasury.remaining(siya), 50 * USD); // a failed pull doesn't use the limit
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
        treasury.lowerLimit(tristan, 0);
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
        treasury.lowerLimit(tristan, 0);
        _proposeDinner();
        _approveAll();
        treasury.settle(ID);
        vm.startPrank(tristan);
        usdc.approve(address(treasury), 0);
        vm.expectRevert(GroupTreasury.TransferFailed.selector);
        treasury.payDebt(neena, 30 * USD);
        vm.stopPrank();
    }

    // --- the headline safety property ---

    /// However the agent is prompted, the operator key alone can't move a member's money.
    function testFuzz_operatorAloneCannotPull(uint256 amount) public {
        amount = bound(amount, 1, 50 * USD);
        address[] memory who = new address[](1);
        who[0] = siya;
        uint256[] memory shares = new uint256[](1);
        shares[0] = amount;
        vm.startPrank(operator);
        treasury.propose(ID, operator, who, shares, uint64(block.timestamp + 1 days));
        vm.expectRevert(GroupTreasury.NotFullyApproved.selector);
        treasury.settle(ID);
        vm.stopPrank();
        assertEq(usdc.balanceOf(siya), 1_000 * USD);
    }
}
