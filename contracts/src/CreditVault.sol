// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CreditVault
/// @notice Prepaid USDG credit for envolvr inference.
///
/// A deposit credits `account`: the wallet whose API keys draw on the balance.
/// Anyone can deposit for any account, so a person can fund an agent's wallet.
/// The control plane reads `Deposited` events and credits balances exactly once
/// per event. Credits are spent per request off chain; the owner withdraws USDG
/// to pay upstream providers.
contract CreditVault is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    uint256 public depositCount;

    event Deposited(address indexed account, address indexed payer, uint256 amount, uint256 indexed depositId);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAccount();

    constructor(IERC20 usdg_, address initialOwner) Ownable(initialOwner) {
        usdg = usdg_;
    }

    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    function depositFor(address account, uint256 amount) external {
        _deposit(account, amount);
    }

    /// @notice Approve and deposit in one transaction with an EIP-2612 permit.
    /// A permit that fails because it was already used (for example front-run) is
    /// ignored; the transfer then succeeds only if the allowance is in place.
    function depositWithPermit(address account, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _deposit(account, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        usdg.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function _deposit(address account, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (account == address(0)) revert ZeroAccount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(account, msg.sender, amount, depositCount++);
    }
}
