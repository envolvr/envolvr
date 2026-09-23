// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EnvolvrToken} from "../src/EnvolvrToken.sol";
import {StakingAllowance} from "../src/StakingAllowance.sol";

/// Deploys a test ENVOLVR token and StakingAllowance. Supply, cooldown and budget
/// notice are placeholders until tokenomics and counsel review are done.
///
///   forge script script/DeployStaking.s.sol --rpc-url robinhood_testnet --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
contract DeployStaking is Script {
    function run() external returns (EnvolvrToken token, StakingAllowance staking) {
        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        uint256 supply = vm.envOr("SUPPLY", uint256(1_000_000_000e18));
        uint256 cooldown = vm.envOr("COOLDOWN_SECONDS", uint256(7 days));
        uint256 notice = vm.envOr("BUDGET_NOTICE_SECONDS", uint256(7 days));
        token = new EnvolvrToken("envolvr", "ENVOLVR", supply, owner);
        staking = new StakingAllowance(token, cooldown, notice, owner);
        vm.stopBroadcast();
        console.log("EnvolvrToken     ", address(token));
        console.log("StakingAllowance ", address(staking));
        console.log("cooldown (s)     ", cooldown);
        console.log("budget notice (s)", notice);
    }
}
