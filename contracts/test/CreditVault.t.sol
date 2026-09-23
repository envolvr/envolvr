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
}
