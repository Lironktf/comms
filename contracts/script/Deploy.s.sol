// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "../src/VendorRegistry.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";

/// Deploys both registries behind ERC1967 (UUPS) proxies.
///
/// Environment:
///   ADMIN_ADDRESS     — receives DEFAULT_ADMIN/GUARDIAN/PAUSER/UPGRADER roles.
///                       For production this MUST be a Safe multisig (see docs/trust-assumptions.md).
///                       Defaults to the broadcaster.
///   VERIFIER_ADDRESS  — optional; granted VERIFIER_ROLE on the AttestationRegistry.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $PK
contract Deploy is Script {
    function run() external returns (VendorRegistry registry, AttestationRegistry attestations) {
        address admin = vm.envOr("ADMIN_ADDRESS", msg.sender);
        address verifier = vm.envOr("VERIFIER_ADDRESS", address(0));

        vm.startBroadcast();

        VendorRegistry registryImpl = new VendorRegistry();
        registry = VendorRegistry(
            address(
                new ERC1967Proxy(address(registryImpl), abi.encodeCall(VendorRegistry.initialize, (admin)))
            )
        );

        AttestationRegistry attImpl = new AttestationRegistry();
        attestations = AttestationRegistry(
            address(
                new ERC1967Proxy(
                    address(attImpl),
                    abi.encodeCall(
                        AttestationRegistry.initialize, (admin, IVendorRegistry(address(registry)))
                    )
                )
            )
        );

        if (verifier != address(0) && admin == msg.sender) {
            attestations.grantRole(attestations.VERIFIER_ROLE(), verifier);
        }

        vm.stopBroadcast();

        console.log("VendorRegistry (proxy):      %s", address(registry));
        console.log("  implementation:            %s", address(registryImpl));
        console.log("AttestationRegistry (proxy): %s", address(attestations));
        console.log("  implementation:            %s", address(attImpl));
        console.log("Admin:                       %s", admin);
        if (verifier != address(0)) console.log("Verifier:                    %s", verifier);
    }
}
