// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./helpers/BaseTest.sol";
import {VendorRegistry} from "../src/VendorRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";

contract VendorRegistryV2Mock is VendorRegistry {
    function version() external pure returns (string memory) {
        return "v2-mock";
    }
}

contract UpgradeTest is BaseTest {
    function test_upgrade_preservesState() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        VendorRegistryV2Mock v2 = new VendorRegistryV2Mock();
        vm.prank(admin);
        registry.upgradeToAndCall(address(v2), "");

        // state written through the old implementation is intact
        IVendorRegistry.VendorView memory v = VendorRegistryV2Mock(address(registry)).getVendor(id);
        assertEq(v.owner, vendorOwner);
        assertEq(v.primaryDomain, DOMAIN);
        assertEq(v.metadataHash, META_HASH);
        assertEq(VendorRegistryV2Mock(address(registry)).version(), "v2-mock");

        // and the registry still functions
        vm.prank(vendorOwner);
        VendorRegistryV2Mock(address(registry)).setX402Endpoint(id, "https://api.acme.example/x402");
    }

    function test_upgrade_deniedWithoutRole() public {
        VendorRegistryV2Mock v2 = new VendorRegistryV2Mock();
        vm.prank(rando);
        vm.expectRevert();
        registry.upgradeToAndCall(address(v2), "");
    }

    function test_upgrade_roleCanBeRevoked() public {
        bytes32 role = registry.UPGRADER_ROLE();
        vm.prank(admin);
        registry.revokeRole(role, admin);
        VendorRegistryV2Mock v2 = new VendorRegistryV2Mock();
        vm.prank(admin);
        vm.expectRevert();
        registry.upgradeToAndCall(address(v2), "");
    }
}
