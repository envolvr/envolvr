// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {WeightsRegistry} from "../src/WeightsRegistry.sol";

/// Deploys ReceiptAnchor and WeightsRegistry, owned by OWNER (defaults to the
/// broadcasting account).
///
///   forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (ReceiptAnchor anchorLog, WeightsRegistry registry) {
        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        anchorLog = new ReceiptAnchor(owner);
        registry = new WeightsRegistry(owner);
        vm.stopBroadcast();
        console.log("ReceiptAnchor   ", address(anchorLog));
        console.log("WeightsRegistry ", address(registry));
        console.log("owner           ", owner);
    }
}
