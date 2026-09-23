// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title EnvolvrToken
/// @notice Fixed-supply ERC-20. The whole supply is minted once to `recipient`;
/// there is no mint function, no owner and no governance. Staking it grants a
/// share of the daily inference budget (see StakingAllowance).
contract EnvolvrToken is ERC20, ERC20Permit {
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _mint(recipient, supply);
    }
}
