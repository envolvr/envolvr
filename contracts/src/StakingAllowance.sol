// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title StakingAllowance
/// @notice Stake ENVOLVR for a pro-rata share of a capped daily inference budget.
///
/// Each staker's allowance for a UTC day is
///     budget(day) * stake(staker, day start) / totalStake(day start)
/// with stake read from checkpoints at 00:00 UTC, so stake added during a day
/// counts from the next day. The gateway meters usage against this off chain.
///
/// Unstaking removes stake from the next snapshot immediately, but the tokens stay
/// locked for `cooldown`. The daily budget changes only at a UTC day boundary at
/// least `budgetNotice` after it is scheduled. Both periods are fixed at deploy,
/// so holders can rely on them.
contract StakingAllowance is Ownable2Step {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant DAY = 1 days;

    IERC20 public immutable token;
    uint256 public immutable cooldown;
    uint256 public immutable budgetNotice;

    mapping(address staker => Checkpoints.Trace208) private _stake;
    Checkpoints.Trace208 private _totalStake;
    /// Daily budget in USD with 6 decimals (USDG units), keyed by effective day start.
    Checkpoints.Trace208 private _budget;

    struct PendingUnstake {
        uint208 amount;
        uint48 unlocksAt;
    }

    mapping(address staker => PendingUnstake) public pendingUnstake;

    event Staked(address indexed staker, uint256 amount);
    event UnstakeRequested(address indexed staker, uint256 amount, uint256 unlocksAt);
    event Withdrawn(address indexed staker, uint256 amount);
    event BudgetScheduled(uint256 dailyBudget, uint256 effectiveFrom);

    error ZeroAmount();
    error InsufficientStake(uint256 staked, uint256 requested);
    error StillLocked(uint256 unlocksAt);
    error NothingToWithdraw();
    error NotDayStart(uint256 timestamp);

    constructor(IERC20 token_, uint256 cooldown_, uint256 budgetNotice_, address initialOwner)
        Ownable(initialOwner)
    {
        token = token_;
        cooldown = cooldown_;
        budgetNotice = budgetNotice_;
    }

    // ---- staking ----

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        _stake[msg.sender].push(_now(), SafeCast.toUint208(_stake[msg.sender].latest() + amount));
        _totalStake.push(_now(), SafeCast.toUint208(_totalStake.latest() + amount));
        emit Staked(msg.sender, amount);
    }

    /// @notice Stop `amount` from counting towards future allowances and start its
    /// cooldown. A new request adds to any pending amount and restarts the cooldown.
    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 staked = _stake[msg.sender].latest();
        if (amount > staked) revert InsufficientStake(staked, amount);
        _stake[msg.sender].push(_now(), uint208(staked - amount));
        _totalStake.push(_now(), uint208(_totalStake.latest() - amount));

        PendingUnstake storage p = pendingUnstake[msg.sender];
        p.amount += uint208(amount);
        p.unlocksAt = SafeCast.toUint48(block.timestamp + cooldown);
        emit UnstakeRequested(msg.sender, amount, p.unlocksAt);
    }

    function withdraw() external {
        PendingUnstake memory p = pendingUnstake[msg.sender];
        if (p.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < p.unlocksAt) revert StillLocked(p.unlocksAt);
        delete pendingUnstake[msg.sender];
        token.safeTransfer(msg.sender, p.amount);
        emit Withdrawn(msg.sender, p.amount);
    }

    // ---- budget ----

    /// @notice Schedule a new daily budget. It takes effect at the first UTC day
    /// start at least `budgetNotice` from now. Scheduling again for the same day
    /// replaces the pending value.
    function scheduleBudget(uint256 dailyBudget) external onlyOwner returns (uint256 effectiveFrom) {
        effectiveFrom = _ceilDay(block.timestamp + budgetNotice);
        _budget.push(SafeCast.toUint48(effectiveFrom), SafeCast.toUint208(dailyBudget));
        emit BudgetScheduled(dailyBudget, effectiveFrom);
    }

    // ---- views ----

    function stakeOf(address staker) external view returns (uint256) {
        return _stake[staker].latest();
    }

    function totalStake() external view returns (uint256) {
        return _totalStake.latest();
    }

    function stakeAt(address staker, uint256 timestamp) public view returns (uint256) {
        return _stake[staker].upperLookupRecent(SafeCast.toUint48(timestamp));
    }

    function totalStakeAt(uint256 timestamp) public view returns (uint256) {
        return _totalStake.upperLookupRecent(SafeCast.toUint48(timestamp));
    }

    function budgetAt(uint256 timestamp) public view returns (uint256) {
        return _budget.upperLookupRecent(SafeCast.toUint48(timestamp));
    }

    /// @notice A staker's allowance for the UTC day starting at `dayStart`, in USD
    /// with 6 decimals. Rounds down, so allowances never sum above the budget.
    function allowanceOf(address staker, uint256 dayStart) external view returns (uint256) {
        if (dayStart % DAY != 0) revert NotDayStart(dayStart);
        uint256 total = totalStakeAt(dayStart);
        if (total == 0) return 0;
        return Math.mulDiv(budgetAt(dayStart), stakeAt(staker, dayStart), total);
    }

    function currentDayStart() external view returns (uint256) {
        return block.timestamp - (block.timestamp % DAY);
    }

    // ---- internal ----

    function _now() private view returns (uint48) {
        return SafeCast.toUint48(block.timestamp);
    }

    function _ceilDay(uint256 t) private pure returns (uint256) {
        uint256 rem = t % DAY;
        return rem == 0 ? t : t + (DAY - rem);
    }
}
