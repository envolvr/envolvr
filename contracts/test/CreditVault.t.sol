// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditVault} from "../src/CreditVault.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";

contract CreditVaultTest is Test {
    MockUSDG internal usdg;
    CreditVault internal vault;
    address internal owner = makeAddr("owner");
    Vm.Wallet internal payer;
    address internal agent = makeAddr("agent");

    function setUp() public {
        usdg = new MockUSDG();
        vault = new CreditVault(usdg, owner);
        payer = vm.createWallet("payer");
        usdg.mint(payer.addr, 1_000e6);
    }

    function test_DepositCreditsSender() public {
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), 5e6);
        vm.expectEmit(address(vault));
        emit CreditVault.Deposited(payer.addr, payer.addr, 5e6, 0);
        vault.deposit(5e6);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(vault)), 5e6);
        assertEq(vault.depositCount(), 1);
    }

    function test_DepositForFundsAnotherWallet() public {
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), 7e6);
        vm.expectEmit(address(vault));
        emit CreditVault.Deposited(agent, payer.addr, 7e6, 0);
        vault.depositFor(agent, 7e6);
        vm.stopPrank();
    }

    function test_DepositWithPermitNeedsNoApproval() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            payer.addr, address(vault), 3e6, usdg.nonces(payer.addr), deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payer, digest);
        vm.prank(payer.addr);
        vault.depositWithPermit(agent, 3e6, deadline, v, r, s);
        assertEq(usdg.balanceOf(address(vault)), 3e6);

        // Replaying the same permit is ignored; with no allowance left the transfer fails.
        vm.prank(payer.addr);
        vm.expectRevert();
        vault.depositWithPermit(agent, 3e6, deadline, v, r, s);
    }

    function test_RejectsZeroAmountAndZeroAccount() public {
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), 1e6);
        vm.expectRevert(CreditVault.ZeroAmount.selector);
        vault.deposit(0);
        vm.expectRevert(CreditVault.ZeroAccount.selector);
        vault.depositFor(address(0), 1e6);
        vm.stopPrank();
    }

    function test_OnlyOwnerWithdraws() public {
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), 10e6);
        vault.deposit(10e6);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer.addr));
        vault.withdraw(payer.addr, 10e6);
        vm.stopPrank();

        address treasury = makeAddr("treasury");
        vm.prank(owner);
        vault.withdraw(treasury, 4e6);
        assertEq(usdg.balanceOf(treasury), 4e6);
    }

    function test_DepositIdsIncrease() public {
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), 3e6);
        vault.deposit(1e6);
        vault.deposit(1e6);
        vm.expectEmit(address(vault));
        emit CreditVault.Deposited(payer.addr, payer.addr, 1e6, 2);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    // ---- automatic top-up ----

    address internal keeper = makeAddr("keeper");

    function _ruleAndKeeper(uint256 amount, uint256 maxPerDay) internal {
        vm.prank(owner);
        vault.setKeeper(keeper);
        vm.startPrank(payer.addr);
        usdg.approve(address(vault), type(uint256).max);
        vault.setTopUpRule(agent, 5e6, amount, maxPerDay);
        vm.stopPrank();
    }

    function test_TopUpPullsTheRuleAmountIntoTheRuleAccount() public {
        _ruleAndKeeper(20e6, 100e6);
        vm.expectEmit(address(vault));
        emit CreditVault.Deposited(agent, payer.addr, 20e6, 0);
        vm.expectEmit(address(vault));
        emit CreditVault.ToppedUp(payer.addr, agent, 20e6, 0);
        vm.prank(keeper);
        uint256 id = vault.topUp(payer.addr, agent);
        assertEq(id, 0);
        assertEq(usdg.balanceOf(address(vault)), 20e6);
        assertEq(usdg.balanceOf(payer.addr), 980e6);
        (uint128 below, uint128 amount, uint128 maxPerDay,, uint128 spent) = vault.topUpRules(payer.addr, agent);
        assertEq(below, 5e6);
        assertEq(amount, 20e6);
        assertEq(maxPerDay, 100e6);
        assertEq(spent, 20e6);
    }

    function test_OnlyTheKeeperTopsUp() public {
        _ruleAndKeeper(20e6, 100e6);
        vm.expectRevert(CreditVault.NotKeeper.selector);
        vault.topUp(payer.addr, agent);
        vm.prank(payer.addr);
        vm.expectRevert(CreditVault.NotKeeper.selector);
        vault.topUp(payer.addr, agent);
        // a cleared keeper disables top-ups
        vm.prank(owner);
        vault.setKeeper(address(0));
        vm.prank(address(0));
        vm.expectRevert(CreditVault.NotKeeper.selector);
        vault.topUp(payer.addr, agent);
    }

    function test_OnlyTheOwnerSetsTheKeeper() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.setKeeper(keeper);
    }

    function test_NoRuleNoTopUp_AndAnotherAccountIsNotTheRuleAccount() public {
        _ruleAndKeeper(20e6, 100e6);
        vm.startPrank(keeper);
        vm.expectRevert(CreditVault.NoRule.selector);
        vault.topUp(payer.addr, makeAddr("someone else"));
        vm.stopPrank();
        vm.prank(payer.addr);
        vault.setTopUpRule(agent, 0, 0, 0);
        vm.prank(keeper);
        vm.expectRevert(CreditVault.NoRule.selector);
        vault.topUp(payer.addr, agent);
    }

    function test_DailyCapHoldsAndResetsTheNextUtcDay() public {
        vm.warp(1_790_000_000);
        _ruleAndKeeper(20e6, 40e6);
        vm.startPrank(keeper);
        vault.topUp(payer.addr, agent);
        vault.topUp(payer.addr, agent);
        vm.expectRevert(CreditVault.DailyCapReached.selector);
        vault.topUp(payer.addr, agent);
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        vault.topUp(payer.addr, agent);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(vault)), 60e6);
    }

    function test_ChangingTheRuleKeepsWhatWasPulledToday() public {
        _ruleAndKeeper(20e6, 40e6);
        vm.prank(keeper);
        vault.topUp(payer.addr, agent);
        vm.prank(payer.addr);
        vault.setTopUpRule(agent, 5e6, 30e6, 40e6);
        vm.prank(keeper);
        vm.expectRevert(CreditVault.DailyCapReached.selector);
        vault.topUp(payer.addr, agent);
    }

    function test_RuleNeedsAnAccountAndACapOfAtLeastOneAmount() public {
        vm.startPrank(payer.addr);
        vm.expectRevert(CreditVault.CapBelowAmount.selector);
        vault.setTopUpRule(agent, 5e6, 20e6, 10e6);
        vm.expectRevert(CreditVault.ZeroAccount.selector);
        vault.setTopUpRule(address(0), 5e6, 20e6, 20e6);
        vm.expectEmit(address(vault));
        emit CreditVault.TopUpRuleSet(payer.addr, agent, 5e6, 20e6, 20e6);
        vault.setTopUpRule(agent, 5e6, 20e6, 20e6);
        vm.stopPrank();
    }

    function test_RevokingTheApprovalStopsTopUps() public {
        _ruleAndKeeper(20e6, 100e6);
        vm.prank(payer.addr);
        usdg.approve(address(vault), 0);
        vm.prank(keeper);
        vm.expectRevert();
        vault.topUp(payer.addr, agent);
    }

    /// Whatever the keeper does within a day, it never pulls more than the cap.
    function testFuzz_KeeperNeverPullsMoreThanTheDailyCap(uint96 amount, uint96 cap, uint8 calls) public {
        amount = uint96(bound(amount, 1, 50e6));
        cap = uint96(bound(cap, amount, 500e6));
        vm.warp(1_790_000_000);
        _ruleAndKeeper(amount, cap);
        uint256 before = usdg.balanceOf(payer.addr);
        for (uint256 i; i < calls % 40; i++) {
            vm.prank(keeper);
            try vault.topUp(payer.addr, agent) {} catch {}
        }
        assertLe(before - usdg.balanceOf(payer.addr), cap);
    }
}
