// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditVault} from "../src/CreditVault.sol";
import {MockUSDG} from "../src/testnet/MockUSDG.sol";

/// Deploys CreditVault for USDG. Without USDG set, deploys MockUSDG first
/// (testnet only).
///
///   forge script script/DeployVault.s.sol --rpc-url robinhood_testnet --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
contract DeployVault is Script {
    function run() external returns (IERC20 usdg, CreditVault vault) {
        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        address usdgAddress = vm.envOr("USDG", address(0));
        if (usdgAddress == address(0)) {
            usdgAddress = address(new MockUSDG());
            console.log("MockUSDG (testnet) ", usdgAddress);
        }
        usdg = IERC20(usdgAddress);
        vault = new CreditVault(usdg, owner);
        vm.stopBroadcast();
        console.log("CreditVault        ", address(vault));
        console.log("USDG               ", usdgAddress);
    }
}
