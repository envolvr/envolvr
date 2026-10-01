// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title CreditVault
/// @notice Prepaid USDG credit for envolvr inference.
///
/// A deposit credits `account`: the wallet whose API keys draw on the balance.
/// Anyone can deposit for any account, so a person can fund an agent's wallet.
/// The control plane reads `Deposited` events and credits balances exactly once
/// per event. Credits are spent per request off chain; the owner withdraws USDG
/// to pay upstream providers.
///
/// Automatic top-up: a payer stores a rule for an account (top up `amount` when
/// its credit falls below `below`, at most `maxPerDay` per UTC day) and approves
/// this vault for USDG. The keeper, a key held by envolvr's attested control
/// plane, sees the account's off-chain credit and calls `topUp` when it is low.
/// The contract enforces the rest: only the rule's amount, only into the rule's
/// account, only up to the daily cap. A keeper can never move a payer's USDG
/// anywhere but into the account the payer chose. The payer ends it any time by
/// clearing the rule or the approval.
contract CreditVault is Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    uint256 public depositCount;

    struct TopUpRule {
        /// Credit, in USDG units, below which the keeper tops up. The keeper reads
        /// it; the contract cannot see off-chain credit.
        uint128 below;
        /// USDG pulled from the payer on each top-up. Zero: no rule.
        uint128 amount;
        /// Most USDG pulled per UTC day for this payer and account.
        uint128 maxPerDay;
        /// The UTC day `spentToday` counts, and what was pulled on it.
        uint64 day;
        uint128 spentToday;
    }

    /// The keeper allowed to execute top-ups; zero disables them.
    address public keeper;
    mapping(address payer => mapping(address account => TopUpRule)) public topUpRules;

    event Deposited(address indexed account, address indexed payer, uint256 amount, uint256 indexed depositId);
    event Withdrawn(address indexed to, uint256 amount);
    event KeeperSet(address keeper);
    event TopUpRuleSet(address indexed payer, address indexed account, uint256 below, uint256 amount, uint256 maxPerDay);
    event ToppedUp(address indexed payer, address indexed account, uint256 amount, uint256 indexed depositId);

    error ZeroAmount();
    error ZeroAccount();
    error NotKeeper();
    error NoRule();
    error CapBelowAmount();
    error DailyCapReached();

    constructor(IERC20 usdg_, address initialOwner) Ownable(initialOwner) {
        usdg = usdg_;
    }

    function deposit(uint256 amount) external {
        _deposit(msg.sender, msg.sender, amount);
    }

    function depositFor(address account, uint256 amount) external {
        _deposit(msg.sender, account, amount);
    }

    /// @notice Approve and deposit in one transaction with an EIP-2612 permit.
    /// A permit that fails because it was already used (for example front-run) is
    /// ignored; the transfer then succeeds only if the allowance is in place.
    function depositWithPermit(address account, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _deposit(msg.sender, account, amount);
    }

    /// @notice Set, change or (with `amount` 0) clear the caller's top-up rule for
    /// `account`. Changing a rule keeps what was already pulled today, so the cap
    /// holds across changes. The caller also approves this vault for USDG.
    function setTopUpRule(address account, uint256 below, uint256 amount, uint256 maxPerDay) external {
        if (account == address(0)) revert ZeroAccount();
        TopUpRule storage rule = topUpRules[msg.sender][account];
        if (amount == 0) {
            rule.below = 0;
            rule.amount = 0;
            rule.maxPerDay = 0;
            emit TopUpRuleSet(msg.sender, account, 0, 0, 0);
            return;
        }
        if (maxPerDay < amount) revert CapBelowAmount();
        rule.below = SafeCast.toUint128(below);
        rule.amount = SafeCast.toUint128(amount);
        rule.maxPerDay = SafeCast.toUint128(maxPerDay);
        emit TopUpRuleSet(msg.sender, account, below, amount, maxPerDay);
    }

    /// @notice Execute `payer`'s rule for `account`: pull the rule's amount and
    /// credit it to the account, within the day's cap. Keeper only.
    function topUp(address payer, address account) external returns (uint256 depositId) {
        if (msg.sender != keeper || keeper == address(0)) revert NotKeeper();
        TopUpRule storage rule = topUpRules[payer][account];
        uint256 amount = rule.amount;
        if (amount == 0) revert NoRule();
        uint64 today = SafeCast.toUint64(block.timestamp / 1 days);
        uint256 spent = rule.day == today ? rule.spentToday : 0;
        if (spent + amount > rule.maxPerDay) revert DailyCapReached();
        rule.day = today;
        rule.spentToday = SafeCast.toUint128(spent + amount);
        depositId = _deposit(payer, account, amount);
        emit ToppedUp(payer, account, amount, depositId);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        usdg.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function _deposit(address payer, address account, uint256 amount) private returns (uint256 depositId) {
        if (amount == 0) revert ZeroAmount();
        if (account == address(0)) revert ZeroAccount();
        usdg.safeTransferFrom(payer, address(this), amount);
        depositId = depositCount++;
        emit Deposited(account, payer, amount, depositId);
    }
}
