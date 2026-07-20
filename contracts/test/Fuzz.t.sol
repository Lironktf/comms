// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./helpers/BaseTest.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";
import {DomainLib} from "../src/libraries/DomainLib.sol";

contract DomainLibHarness {
    function isValid(string memory d) external pure returns (bool) {
        return DomainLib.isValid(d);
    }
}

contract FuzzTest is BaseTest {
    DomainLibHarness internal lib;

    function setUp() public override {
        super.setUp();
        lib = new DomainLibHarness();
    }

    // -----------------------------------------------------------------
    // DomainLib
    // -----------------------------------------------------------------

    /// Any accepted domain must satisfy every structural rule we claim to enforce.
    function testFuzz_domainValidation_soundness(bytes calldata raw) public view {
        string memory d = string(raw);
        if (!lib.isValid(d)) return;

        bytes memory b = bytes(d);
        assertGe(b.length, 4);
        assertLe(b.length, 253);
        assertTrue(b[0] != "." && b[0] != "-");
        assertTrue(b[b.length - 1] != "." && b[b.length - 1] != "-");

        bool hasDot = false;
        uint256 labelLen = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool lower = (c >= "a" && c <= "z");
            bool digit = (c >= "0" && c <= "9");
            assertTrue(lower || digit || c == "." || c == "-", "charset");
            if (c == ".") {
                hasDot = true;
                assertGt(labelLen, 0, "empty label");
                assertTrue(b[i - 1] != "-", "label ends with hyphen");
                labelLen = 0;
            } else {
                labelLen++;
                assertLe(labelLen, 63, "label too long");
            }
        }
        assertTrue(hasDot, "needs at least two labels");
    }

    /// Well-formed generated domains must always be accepted (completeness direction).
    function testFuzz_domainValidation_acceptsGenerated(uint256 seed) public view {
        string memory d = _genDomain(seed);
        assertTrue(lib.isValid(d), d);
    }

    // -----------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------

    /// Registering any two distinct generated domains yields distinct vendor ids, and both
    /// resolve back to their owners; registering the same domain twice always reverts.
    function testFuzz_register_uniqueness(uint256 seedA, uint256 seedB) public {
        string memory da = _genDomain(seedA);
        string memory db = _genDomain(seedB);

        string[] memory extra = new string[](0);
        address[] memory none = new address[](0);

        vm.prank(vendorOwner);
        bytes32 idA = registry.registerVendor(da, extra, none, "", bytes32(0), "");

        if (keccak256(bytes(da)) == keccak256(bytes(db))) {
            vm.prank(otherOwner);
            vm.expectRevert();
            registry.registerVendor(db, extra, none, "", bytes32(0), "");
        } else {
            vm.prank(otherOwner);
            bytes32 idB = registry.registerVendor(db, extra, none, "", bytes32(0), "");
            assertTrue(idA != idB);
            assertEq(registry.vendorIdForDomain(da), idA);
            assertEq(registry.vendorIdForDomain(db), idB);
            assertEq(registry.vendorOwner(idA), vendorOwner);
            assertEq(registry.vendorOwner(idB), otherOwner);
        }
    }

    /// Metadata version strictly increments and the anchored hash always matches the last write.
    function testFuzz_metadataVersioning(bytes32[8] calldata hashes) public {
        bytes32 id = _registerVendor(vendorOwner, DOMAIN);
        uint64 expectedVersion = 1; // registration anchored v1
        for (uint256 i = 0; i < hashes.length; i++) {
            bytes32 h = hashes[i];
            vm.prank(vendorOwner);
            if (h == bytes32(0)) {
                vm.expectRevert(IVendorRegistry.ZeroHash.selector);
                registry.setMetadata(id, h, "u");
            } else {
                registry.setMetadata(id, h, "u");
                expectedVersion++;
                assertEq(registry.metadataHashOf(id), h);
            }
            assertEq(registry.getVendor(id).metadataVersion, expectedVersion);
        }
    }

    // -----------------------------------------------------------------
    // Attestations
    // -----------------------------------------------------------------

    /// An attestation is active exactly within [issuedAt, expiresAt) for an Active vendor.
    function testFuzz_attestationExpiryWindow(uint32 validitySeconds, uint32 elapsed) public {
        validitySeconds = uint32(bound(validitySeconds, 1, 730 days));
        bytes32 vid = _registerVendor(vendorOwner, DOMAIN);
        uint64 expiresAt = uint64(block.timestamp) + validitySeconds;

        vm.prank(verifier);
        bytes32 id = attestations.attest(vid, 1, keccak256("e"), expiresAt);

        vm.warp(block.timestamp + uint256(elapsed));
        bool expectedActive = block.timestamp < expiresAt;
        assertEq(attestations.isAttestationActive(id), expectedActive);
        assertEq(attestations.verificationLevel(vid), expectedActive ? 1 : 0);
    }

    /// Signature relay: only the exact signed payload with the current nonce is accepted.
    function testFuzz_attestWithSignature_nonceMustMatch(uint64 nonce) public {
        vm.assume(nonce != 0);
        bytes32 vid = _registerVendor(vendorOwner, DOMAIN);
        AttestationRegistry.AttestationRequest memory req = AttestationRegistry.AttestationRequest({
            vendorId: vid,
            attType: 1,
            evidenceHash: keccak256("e"),
            expiresAt: uint64(block.timestamp + 30 days),
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _signAttestation(verifierPk, req);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidNonce.selector, 0, nonce));
        attestations.attestWithSignature(req, sig);
    }

    // -----------------------------------------------------------------
    // Generators
    // -----------------------------------------------------------------

    bytes internal constant ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

    /// Generates a structurally valid two-label lowercase domain from a seed.
    function _genDomain(uint256 seed) internal pure returns (string memory) {
        bytes memory name = new bytes(1 + (seed % 20));
        uint256 s = uint256(keccak256(abi.encode(seed)));
        for (uint256 i = 0; i < name.length; i++) {
            name[i] = ALPHANUM[s % ALPHANUM.length];
            s = uint256(keccak256(abi.encode(s)));
        }
        return string.concat(string(name), ".example");
    }
}
