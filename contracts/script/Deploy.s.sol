// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GroupTreasury, IERC20} from "../src/GroupTreasury.sol";

/// Deploys one GroupTreasury (one per group chat).
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    /// Arc testnet USDC (ERC-20 interface to native USDC, 6 decimals).
    address constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (GroupTreasury treasury) {
        address usdc = vm.envOr("USDC_ADDRESS", ARC_TESTNET_USDC);
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        vm.startBroadcast();
        treasury = new GroupTreasury(IERC20(usdc), operator);
        vm.stopBroadcast();
        console.log("GroupTreasury:", address(treasury));
    }
}
