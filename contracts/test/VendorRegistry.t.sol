// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./helpers/BaseTest.sol";
import {VendorRegistry} from "../src/VendorRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";
import {DomainLib} from "../src/libraries/DomainLib.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract VendorRegistryTest is BaseTest {
    // -----------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------

    function test_register_success() public {
        string[] memory extra = new string[](1);
        extra[0] = "acme-api.example";
        address[] memory wallets = new address[](2);
        wallets[0] = makeAddr("w1");
        wallets[1] = makeAddr("w2");

        vm.expectEmit(true, true, false, true);
        emit IVendorRegistry.VendorRegistered(
            registry.computeVendorId(DOMAIN), vendorOwner, DOMAIN, uint64(block.timestamp)
        );

        vm.prank(vendorOwner);
        bytes32 id = registry.registerVendor(DOMAIN, extra, wallets, "https://api.acme.example/x402", META_HASH, META_URI);

        IVendorRegistry.VendorView memory v = registry.getVendor(id);
        assertEq(v.owner, vendorOwner);
        assertEq(uint8(v.status), uint8(IVendorRegistry.VendorStatus.Active));
        assertEq(v.primaryDomain, DOMAIN);
        assertEq(v.domains.length, 2);
        assertEq(v.wallets.length, 2);
        assertEq(v.metadataHash, META_HASH);
        assertEq(v.metadataVersion, 1);
        assertEq(v.x402Endpoint, "https://api.acme.example/x402");
        assertEq(registry.vendorIdForDomain(DOMAIN), id);
        assertEq(registry.vendorIdForDomain("acme-api.example"), id);
        assertEq(registry.vendorIdForWallet(wallets[0]), id);
        assertEq(registry.vendorCount(), 1);
        assertEq(registry.vendorIdAt(0), id);
    }

    function test_register_withoutMetadata_versionZero() public {
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](0);
        vm.prank(vendorOwner);
        bytes32 id = registry.registerVendor(DOMAIN, extra, wallets, "", bytes32(0), "");
        assertEq(registry.getVendor(id).metadataVersion, 0);
        assertEq(registry.metadataHashOf(id), bytes32(0));
    }

    function test_register_duplicateVendorId_reverts() public {
        _registerVendor(vendorOwner, DOMAIN);
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](0);
        vm.prank(otherOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVendorRegistry.VendorAlreadyRegistered.selector, registry.computeVendorId(DOMAIN)
            )
        );
        registry.registerVendor(DOMAIN, extra, wallets, "", bytes32(0), "");
    }

    function test_register_claimedDomain_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        string[] memory extra = new string[](1);
        extra[0] = DOMAIN; // already claimed as another vendor's primary
        address[] memory wallets = new address[](0);
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.DomainAlreadyClaimed.selector, DOMAIN, id));
        registry.registerVendor("other.example", extra, wallets, "", bytes32(0), "");
    }

    function test_register_claimedWallet_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        address claimed = registry.getVendor(id).wallets[0];
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](1);
        wallets[0] = claimed;
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.WalletAlreadyClaimed.selector, claimed, id));
        registry.registerVendor("other.example", extra, wallets, "", bytes32(0), "");
    }

    function test_register_invalidDomains_revert() public {
        string[] memory bad = new string[](8);
        bad[0] = "UPPER.example"; // uppercase rejected, normalization is offchain
        bad[1] = "no-dot";
        bad[2] = "-bad.example";
        bad[3] = "bad-.example";
        bad[4] = "bad..example";
        bad[5] = ".bad.example";
        bad[6] = "bad.example.";
        bad[7] = unicode"acmé.example";

        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](0);
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(vendorOwner);
            vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.InvalidDomain.selector, bad[i]));
            registry.registerVendor(bad[i], extra, wallets, "", bytes32(0), "");
        }
    }

    function test_register_domainCap() public {
        string[] memory extra = new string[](16); // 1 primary + 16 = 17 > 16
        for (uint256 i = 0; i < extra.length; i++) {
            extra[i] = string.concat("sub", vm.toString(i), ".acme.example");
        }
        address[] memory wallets = new address[](0);
        vm.prank(vendorOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.TooManyDomains.selector, 16));
        registry.registerVendor(DOMAIN, extra, wallets, "", bytes32(0), "");
    }

    function test_register_zeroWallet_reverts() public {
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](1);
        wallets[0] = address(0);
        vm.prank(vendorOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.InvalidWallet.selector, address(0)));
        registry.registerVendor(DOMAIN, extra, wallets, "", bytes32(0), "");
    }

    function test_computeVendorId_deterministic() public view {
        bytes32 expected = keccak256(abi.encode(keccak256("actp.vendor.v1"), keccak256(bytes(DOMAIN))));
        assertEq(registry.computeVendorId(DOMAIN), expected);
    }

    // -----------------------------------------------------------------
    // Domain / wallet management
    // -----------------------------------------------------------------

    function test_addRemoveDomain() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        vm.prank(vendorOwner);
        registry.addDomain(id, "shop.acme.example");
        assertEq(registry.vendorIdForDomain("shop.acme.example"), id);

        vm.prank(vendorOwner);
        registry.removeDomain(id, "shop.acme.example");
        assertEq(registry.vendorIdForDomain("shop.acme.example"), bytes32(0));
        // released domain is claimable by another vendor
        bytes32 other = _registerVendor(otherOwner, "other.example");
        vm.prank(otherOwner);
        registry.addDomain(other, "shop.acme.example");
        assertEq(registry.vendorIdForDomain("shop.acme.example"), other);
    }

    function test_removePrimaryDomain_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(vendorOwner);
        vm.expectRevert(IVendorRegistry.CannotRemovePrimaryDomain.selector);
        registry.removeDomain(id, DOMAIN);
    }

    function test_removeDomain_notOwned_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        _registerVendor(otherOwner, "other.example");
        vm.prank(vendorOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.DomainNotFound.selector, "other.example"));
        registry.removeDomain(id, "other.example");
    }

    function test_addRemoveWallet() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        address w = makeAddr("newWallet");

        vm.prank(vendorOwner);
        registry.addWallet(id, w);
        assertEq(registry.vendorIdForWallet(w), id);

        vm.prank(vendorOwner);
        registry.removeWallet(id, w);
        assertEq(registry.vendorIdForWallet(w), bytes32(0));
        assertEq(registry.getVendor(id).wallets.length, 1);
    }

    function test_mutations_onlyOwner() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.startPrank(rando);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, id, rando));
        registry.addDomain(id, "x.example");
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, id, rando));
        registry.setMetadata(id, keccak256("h"), "u");
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, id, rando));
        registry.setX402Endpoint(id, "https://x");
        vm.stopPrank();
    }

    function test_mutations_blockedWhenSuspended() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(guardian);
        registry.suspendVendor(id, "abuse report");
        vm.prank(vendorOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.VendorNotActive.selector, id));
        registry.setMetadata(id, keccak256("h2"), "u2");
    }

    // -----------------------------------------------------------------
    // Metadata anchoring
    // -----------------------------------------------------------------

    function test_setMetadata_bumpsVersion() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        bytes32 h2 = keccak256("metadata-v2");

        vm.expectEmit(true, true, false, true);
        emit IVendorRegistry.MetadataUpdated(id, 2, h2, "uri2");
        vm.prank(vendorOwner);
        registry.setMetadata(id, h2, "uri2");

        IVendorRegistry.VendorView memory v = registry.getVendor(id);
        assertEq(v.metadataVersion, 2);
        assertEq(v.metadataHash, h2);
    }

    function test_setMetadata_zeroHash_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(vendorOwner);
        vm.expectRevert(IVendorRegistry.ZeroHash.selector);
        registry.setMetadata(id, bytes32(0), "");
    }

    function test_setContractMetadataHash() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(vendorOwner);
        registry.setContractMetadataHash(id, keccak256("terms-v1"));
        IVendorRegistry.VendorView memory v = registry.getVendor(id);
        assertEq(v.contractMetadataVersion, 1);
        assertEq(v.contractMetadataHash, keccak256("terms-v1"));
    }

    // -----------------------------------------------------------------
    // Two-step ownership transfer
    // -----------------------------------------------------------------

    function test_ownershipTransfer_twoStep() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        vm.prank(vendorOwner);
        registry.transferVendorOwnership(id, otherOwner);
        assertEq(registry.vendorOwner(id), vendorOwner); // unchanged until accepted

        vm.prank(otherOwner);
        registry.acceptVendorOwnership(id);
        assertEq(registry.vendorOwner(id), otherOwner);
        assertEq(registry.getVendor(id).pendingOwner, address(0));

        // old owner locked out
        vm.prank(vendorOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, id, vendorOwner));
        registry.setX402Endpoint(id, "https://x");
    }

    function test_ownershipTransfer_onlyPendingCanAccept() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(vendorOwner);
        registry.transferVendorOwnership(id, otherOwner);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotPendingOwner.selector, id, rando));
        registry.acceptVendorOwnership(id);
    }

    function test_ownershipTransfer_zeroAddress_reverts() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(vendorOwner);
        vm.expectRevert(IVendorRegistry.ZeroAddress.selector);
        registry.transferVendorOwnership(id, address(0));
    }

    function test_ownershipTransfer_worksWhileSuspended() public {
        // key-recovery path: suspended vendors can still change owner
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(guardian);
        registry.suspendVendor(id, "compromised key");
        vm.prank(vendorOwner);
        registry.transferVendorOwnership(id, otherOwner);
        vm.prank(otherOwner);
        registry.acceptVendorOwnership(id);
        assertEq(registry.vendorOwner(id), otherOwner);
    }

    // -----------------------------------------------------------------
    // Lifecycle state machine
    // -----------------------------------------------------------------

    function test_suspend_unsuspend_revoke_flow() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        vm.prank(guardian);
        registry.suspendVendor(id, "reports");
        assertEq(uint8(registry.vendorStatus(id)), uint8(IVendorRegistry.VendorStatus.Suspended));

        vm.prank(guardian);
        registry.unsuspendVendor(id, "cleared");
        assertEq(uint8(registry.vendorStatus(id)), uint8(IVendorRegistry.VendorStatus.Active));

        vm.prank(guardian);
        registry.revokeVendor(id, "fraud confirmed");
        assertEq(uint8(registry.vendorStatus(id)), uint8(IVendorRegistry.VendorStatus.Revoked));
    }

    function test_invalidTransitions_revert() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        // Active -> Active (unsuspend on active)
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVendorRegistry.InvalidStatusTransition.selector,
                IVendorRegistry.VendorStatus.Active,
                IVendorRegistry.VendorStatus.Active
            )
        );
        registry.unsuspendVendor(id, "noop");

        vm.prank(guardian);
        registry.revokeVendor(id, "gone");

        // Revoked is terminal
        vm.startPrank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVendorRegistry.InvalidStatusTransition.selector,
                IVendorRegistry.VendorStatus.Revoked,
                IVendorRegistry.VendorStatus.Suspended
            )
        );
        registry.suspendVendor(id, "x");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVendorRegistry.InvalidStatusTransition.selector,
                IVendorRegistry.VendorStatus.Revoked,
                IVendorRegistry.VendorStatus.Active
            )
        );
        registry.unsuspendVendor(id, "x");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVendorRegistry.InvalidStatusTransition.selector,
                IVendorRegistry.VendorStatus.Revoked,
                IVendorRegistry.VendorStatus.Revoked
            )
        );
        registry.revokeVendor(id, "x");
        vm.stopPrank();
    }

    function test_ownerCanSelfRevoke_randoCannot() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, id, rando));
        registry.revokeVendor(id, "grief");

        vm.prank(vendorOwner);
        registry.revokeVendor(id, "shutting down");
        assertEq(uint8(registry.vendorStatus(id)), uint8(IVendorRegistry.VendorStatus.Revoked));
    }

    function test_lifecycle_onlyGuardian() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        vm.prank(rando);
        vm.expectRevert();
        registry.suspendVendor(id, "x");
        // vendor owner also cannot suspend (only guardian)
        vm.prank(vendorOwner);
        vm.expectRevert();
        registry.suspendVendor(id, "x");
    }

    function test_revokedIdentifiers_quarantined() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        address w = registry.getVendor(id).wallets[0];
        vm.prank(guardian);
        registry.revokeVendor(id, "fraud");

        // same primary domain -> same vendorId -> blocked forever
        string[] memory extra = new string[](0);
        address[] memory none = new address[](0);
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.VendorAlreadyRegistered.selector, id));
        registry.registerVendor(DOMAIN, extra, none, "", bytes32(0), "");

        // revoked vendor's wallet also stays claimed
        address[] memory wallets = new address[](1);
        wallets[0] = w;
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.WalletAlreadyClaimed.selector, w, id));
        registry.registerVendor("fresh.example", extra, wallets, "", bytes32(0), "");
    }

    // -----------------------------------------------------------------
    // Pause
    // -----------------------------------------------------------------

    function test_pause_blocksRegistrationAndMutations_guardianStillWorks() public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);

        vm.prank(admin);
        registry.pause();

        string[] memory extra = new string[](0);
        address[] memory none = new address[](0);
        vm.prank(otherOwner);
        vm.expectRevert();
        registry.registerVendor("other.example", extra, none, "", bytes32(0), "");

        vm.prank(vendorOwner);
        vm.expectRevert();
        registry.setMetadata(id, keccak256("h"), "u");

        // incident response still available while paused
        vm.prank(guardian);
        registry.suspendVendor(id, "incident");

        vm.prank(admin);
        registry.unpause();
        vm.prank(otherOwner);
        registry.registerVendor("other.example", extra, none, "", bytes32(0), "");
    }

    function test_pause_onlyPauserRole() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.pause();
    }

    // -----------------------------------------------------------------
    // Views / misc
    // -----------------------------------------------------------------

    function test_getVendor_unknown_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.VendorNotFound.selector, bytes32(uint256(1))));
        registry.getVendor(bytes32(uint256(1)));
    }

    function test_initialize_cannotRerun() public {
        vm.expectRevert();
        registry.initialize(rando);
    }

    function test_implementation_cannotBeInitialized() public {
        VendorRegistry impl = new VendorRegistry();
        vm.expectRevert();
        impl.initialize(rando);
    }
}
