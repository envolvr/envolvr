// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnvolvrToken} from "../src/EnvolvrToken.sol";
import {StakingAllowance} from "../src/StakingAllowance.sol";

contract StakingAllowanceTest is Test {
    EnvolvrToken internal token;
    StakingAllowance internal staking;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant DAY = 1 days;
    uint256 internal constant COOLDOWN = 7 days;
    uint256 internal constant NOTICE = 7 days;
    uint256 internal constant D0 = 20_000 * DAY; // a UTC day start in 2024
    uint256 internal constant BUDGET = 1_000e6; // $1,000 a day, 6 decimals

    function setUp() public {
        vm.warp(D0);
        token = new EnvolvrToken("envolvr", "ENVOLVR", 1_000_000_000e18, owner);
        staking = new StakingAllowance(token, COOLDOWN, NOTICE, owner);
        vm.startPrank(owner);
        token.transfer(alice, 1_000_000e18);
        token.transfer(bob, 1_000_000e18);
        staking.scheduleBudget(BUDGET); // effective D0 + 7 days
        vm.stopPrank();
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function test_Token_FixedSupplyToRecipient() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(owner), 1_000_000_000e18 - 2_000_000e18);
    }

    function test_Budget_TakesEffectAtDayStartAfterNotice() public {
        assertEq(staking.budgetAt(D0), 0);
        assertEq(staking.budgetAt(D0 + NOTICE - 1), 0);
        assertEq(staking.budgetAt(D0 + NOTICE), BUDGET);

        // Scheduled mid-day: rounds up to the next day start after the notice.
        vm.warp(D0 + NOTICE + 5 hours);
        vm.prank(owner);
        uint256 effective = staking.scheduleBudget(2 * BUDGET);
        assertEq(effective, D0 + 2 * NOTICE + DAY);
        assertEq(staking.budgetAt(effective - 1), BUDGET);
        assertEq(staking.budgetAt(effective), 2 * BUDGET);
    }

    function test_Budget_RescheduleSameDayReplaces() public {
        vm.startPrank(owner);
        staking.scheduleBudget(5e6);
        assertEq(staking.budgetAt(D0 + NOTICE), 5e6);
        vm.stopPrank();
    }

    function test_Budget_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        staking.scheduleBudget(1);
    }

    function test_Allowance_ProRataAtDayStart() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        uint256 day = D0 + NOTICE;
        assertEq(staking.allowanceOf(alice, day), 750e6);
        assertEq(staking.allowanceOf(bob, day), 250e6);
    }

    function test_Allowance_StakeDuringDayCountsFromNextDay() public {
        uint256 day = D0 + NOTICE;
        _stake(alice, 100e18);
        vm.warp(day + 10 hours);
        _stake(bob, 100e18);
        assertEq(staking.allowanceOf(alice, day), BUDGET, "bob's stake is after the snapshot");
        assertEq(staking.allowanceOf(bob, day), 0);
        assertEq(staking.allowanceOf(bob, day + DAY), BUDGET / 2);
    }

    function test_Allowance_ZeroWithoutStakeOrBudget() public view {
        assertEq(staking.allowanceOf(alice, D0 + NOTICE), 0);
        assertEq(staking.allowanceOf(alice, D0), 0);
    }

    function test_Allowance_RejectsNonDayStart() public {
        vm.expectRevert(abi.encodeWithSelector(StakingAllowance.NotDayStart.selector, D0 + 1));
        staking.allowanceOf(alice, D0 + 1);
    }

    function test_Unstake_StopsCountingAndLocksForCooldown() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        uint256 day = D0 + NOTICE;
        vm.warp(day + 1 hours);
        vm.prank(alice);
        staking.requestUnstake(100e18);

        assertEq(staking.allowanceOf(alice, day), BUDGET / 2, "today's snapshot is already taken");
        assertEq(staking.allowanceOf(alice, day + DAY), 0);
        assertEq(staking.allowanceOf(bob, day + DAY), BUDGET);

        (, uint48 unlocksAt) = staking.pendingUnstake(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingAllowance.StillLocked.selector, unlocksAt));
        vm.prank(alice);
        staking.withdraw();

        vm.warp(unlocksAt);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        staking.withdraw();
        assertEq(token.balanceOf(alice) - before, 100e18);
    }

    function test_Unstake_NewRequestRestartsCooldown() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        staking.requestUnstake(40e18);
        vm.warp(D0 + 3 days);
        vm.prank(alice);
        staking.requestUnstake(10e18);
        (uint208 amount, uint48 unlocksAt) = staking.pendingUnstake(alice);
        assertEq(amount, 50e18);
        assertEq(unlocksAt, D0 + 3 days + COOLDOWN);
    }

    function test_Unstake_RevertsAboveStake() public {
        _stake(alice, 10e18);
        vm.expectRevert(abi.encodeWithSelector(StakingAllowance.InsufficientStake.selector, 10e18, 11e18));
        vm.prank(alice);
        staking.requestUnstake(11e18);
    }

    function test_Withdraw_RevertsWithNothingPending() public {
        vm.expectRevert(StakingAllowance.NothingToWithdraw.selector);
        vm.prank(alice);
        staking.withdraw();
    }

    /// Rounding down keeps the sum of allowances within the budget, and loses at
    /// most one unit per staker.
    function testFuzz_AllowancesNeverExceedBudget(uint96[5] memory amounts, uint64 budget) public {
        vm.prank(owner);
        staking.scheduleBudget(budget);
        uint256 day = D0 + NOTICE;
        address[5] memory stakers;
        for (uint256 i; i < 5; ++i) {
            stakers[i] = address(uint160(0x1000 + i));
            uint256 amount = bound(amounts[i], 1, 1_000_000e18);
            deal(address(token), stakers[i], amount);
            vm.startPrank(stakers[i]);
            token.approve(address(staking), amount);
            staking.stake(amount);
            vm.stopPrank();
        }
        uint256 sum;
        for (uint256 i; i < 5; ++i) {
            sum += staking.allowanceOf(stakers[i], day);
        }
        assertLe(sum, budget);
        assertGe(sum + 5, budget);
    }

    /// The contract always holds exactly the staked plus pending tokens.
    function testFuzz_BalanceMatchesStakePlusPending(uint96 a, uint96 b, uint96 unstakeA) public {
        uint256 sa = bound(a, 1, 1_000_000e18);
        uint256 sb = bound(b, 1, 1_000_000e18);
        _stake(alice, sa);
        _stake(bob, sb);
        uint256 ua = bound(unstakeA, 1, sa);
        vm.prank(alice);
        staking.requestUnstake(ua);
        (uint208 pending,) = staking.pendingUnstake(alice);
        assertEq(token.balanceOf(address(staking)), staking.totalStake() + pending);

        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        staking.withdraw();
        assertEq(token.balanceOf(address(staking)), staking.totalStake());
        assertEq(staking.totalStake(), sa + sb - ua);
    }
}
