// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice TESTNET ONLY. Stand-in for USDG (6 decimals, EIP-2612 permit) with an
/// open mint. Robinhood Chain testnet has no official USDG faucet.
contract MockUSDG is ERC20, ERC20Permit {
    constructor() ERC20("Mock USDG (envolvr testnet)", "mUSDG") ERC20Permit("Mock USDG (envolvr testnet)") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
