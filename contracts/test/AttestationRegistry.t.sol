// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./helpers/BaseTest.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";

contract AttestationRegistryTest is BaseTest {
    bytes32 internal vendorId;

    uint8 constant T_DOMAIN = 1;
    uint8 constant T_WALLET = 2;
    uint8 constant T_LEGAL = 3;
    uint8 constant T_VENDOR_SIGNED = 4;
    uint8 constant T_AUDITED = 5;

    function setUp() public override {
        super.setUp();
        vendorId = _registerVendor(vendorOwner, DOMAIN);
    }

    function _expiry(uint256 daysAhead) internal view returns (uint64) {
        return uint64(block.timestamp + daysAhead * 1 days);
    }

    // -----------------------------------------------------------------
    // Direct attestation
    // -----------------------------------------------------------------

    function test_attest_success_and_level() public {
        assertEq(attestations.verificationLevel(vendorId), 0);

        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_DOMAIN, keccak256("dns-challenge-log"), _expiry(365));

        AttestationRegistry.Attestation memory a = attestations.getAttestation(id);
        assertEq(a.vendorId, vendorId);
        assertEq(uint8(a.attType), T_DOMAIN);
        assertEq(a.attester, verifier);
        assertTrue(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 1);
        assertTrue(attestations.hasActiveAttestation(vendorId, T_DOMAIN));
    }

    function test_attest_levelIsHighestActiveType() public {
        vm.startPrank(verifier);
        attestations.attest(vendorId, T_DOMAIN, keccak256("e1"), _expiry(365));
        attestations.attest(vendorId, T_LEGAL, keccak256("kyb-report"), _expiry(180));
        vm.stopPrank();
        assertEq(attestations.verificationLevel(vendorId), 3);

        vm.prank(verifier);
        attestations.attest(vendorId, T_AUDITED, keccak256("audit"), _expiry(365));
        assertEq(attestations.verificationLevel(vendorId), 5);
    }

    function test_attest_nonVerifier_reverts() public {
        vm.prank(rando);
        vm.expectRevert();
        attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(30));
    }

    function test_attest_vendorSignedType_forbiddenForVerifier() public {
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.InvalidAttestationType.selector, T_VENDOR_SIGNED)
        );
        attestations.attest(vendorId, T_VENDOR_SIGNED, keccak256("e"), _expiry(30));
    }

    function test_attest_invalidTypes_revert() public {
        vm.startPrank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidAttestationType.selector, 0));
        attestations.attest(vendorId, 0, keccak256("e"), _expiry(30));
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidAttestationType.selector, 6));
        attestations.attest(vendorId, 6, keccak256("e"), _expiry(30));
        vm.stopPrank();
    }

    function test_attest_expiryBounds() public {
        vm.startPrank(verifier);
        // in the past
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.InvalidExpiry.selector, uint64(block.timestamp))
        );
        attestations.attest(vendorId, T_DOMAIN, keccak256("e"), uint64(block.timestamp));
        // beyond MAX_VALIDITY
        uint64 tooFar = uint64(block.timestamp + 731 days);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidExpiry.selector, tooFar));
        attestations.attest(vendorId, T_DOMAIN, keccak256("e"), tooFar);
        vm.stopPrank();
    }

    function test_attest_unknownOrInactiveVendor_reverts() public {
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.VendorNotFoundOrInactive.selector, bytes32(uint256(9)))
        );
        attestations.attest(bytes32(uint256(9)), T_DOMAIN, keccak256("e"), _expiry(30));

        vm.prank(guardian);
        registry.suspendVendor(vendorId, "x");
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.VendorNotFoundOrInactive.selector, vendorId)
        );
        attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(30));
    }

    // -----------------------------------------------------------------
    // Expiry / lifecycle interaction
    // -----------------------------------------------------------------

    function test_expiry_deactivatesAttestation_andLevelDrops() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(30));
        assertEq(attestations.verificationLevel(vendorId), 1);

        vm.warp(block.timestamp + 30 days);
        assertFalse(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 0);
    }

    function test_renewal_restoresLevel() public {
        vm.prank(verifier);
        attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(30));
        vm.warp(block.timestamp + 31 days);
        assertEq(attestations.verificationLevel(vendorId), 0);

        vm.prank(verifier);
        attestations.attest(vendorId, T_DOMAIN, keccak256("e2"), _expiry(30));
        assertEq(attestations.verificationLevel(vendorId), 1);
    }

    function test_suspendedVendor_attestationsInactive_reactivateOnUnsuspend() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_LEGAL, keccak256("kyb"), _expiry(365));
        assertEq(attestations.verificationLevel(vendorId), 3);

        vm.prank(guardian);
        registry.suspendVendor(vendorId, "investigating");
        assertFalse(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 0);

        vm.prank(guardian);
        registry.unsuspendVendor(vendorId, "cleared");
        assertTrue(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 3);
    }

    // -----------------------------------------------------------------
    // Signature-relayed attestation (EIP-712)
    // -----------------------------------------------------------------

    function _req(uint8 attType, uint256 nonce) internal view returns (AttestationRegistry.AttestationRequest memory) {
        return AttestationRegistry.AttestationRequest({
            vendorId: vendorId,
            attType: attType,
            evidenceHash: keccak256("evidence"),
            expiresAt: _expiry(365),
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function test_attestWithSignature_success_relayedByAnyone() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(verifierPk, req);

        vm.prank(rando); // relayer, not the verifier
        bytes32 id = attestations.attestWithSignature(req, sig);

        AttestationRegistry.Attestation memory a = attestations.getAttestation(id);
        assertEq(a.attester, verifier); // attributed to signer, not relayer
        assertEq(attestations.nonceOf(verifier), 1);
        assertEq(attestations.verificationLevel(vendorId), 1);
    }

    function test_attestWithSignature_replay_reverts() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(verifierPk, req);
        vm.prank(rando);
        attestations.attestWithSignature(req, sig);

        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidNonce.selector, 1, 0));
        attestations.attestWithSignature(req, sig);
    }

    function test_attestWithSignature_wrongNonce_reverts() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 5);
        bytes memory sig = _signAttestation(verifierPk, req);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidNonce.selector, 0, 5));
        attestations.attestWithSignature(req, sig);
    }

    function test_attestWithSignature_expiredDeadline_reverts() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(verifierPk, req);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.SignatureExpired.selector, req.deadline));
        attestations.attestWithSignature(req, sig);
    }

    function test_attestWithSignature_nonVerifierSigner_reverts() public {
        uint256 attackerPk = 0xBAD;
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(attackerPk, req);
        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.SignerNotVerifier.selector, vm.addr(attackerPk))
        );
        attestations.attestWithSignature(req, sig);
    }

    function test_attestWithSignature_tamperedPayload_reverts() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(verifierPk, req);
        req.attType = T_AUDITED; // escalate after signing
        vm.prank(rando);
        // recovered signer differs -> either not a verifier or wrong nonce; must revert
        vm.expectRevert();
        attestations.attestWithSignature(req, sig);
    }

    function test_attestWithSignature_revokedVerifierRole_reverts() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_DOMAIN, 0);
        bytes memory sig = _signAttestation(verifierPk, req);
        bytes32 role = attestations.VERIFIER_ROLE();
        vm.prank(admin);
        attestations.revokeRole(role, verifier);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.SignerNotVerifier.selector, verifier));
        attestations.attestWithSignature(req, sig);
    }

    // -----------------------------------------------------------------
    // VendorSigned (level 4)
    // -----------------------------------------------------------------

    function test_vendorSignMetadata_success() public {
        vm.prank(vendorOwner);
        bytes32 id = attestations.vendorSignMetadata(vendorId);
        assertTrue(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 4);
        AttestationRegistry.Attestation memory a = attestations.getAttestation(id);
        assertEq(a.evidenceHash, META_HASH);
        assertEq(a.attester, vendorOwner);
    }

    function test_vendorSignMetadata_onlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.NotVendorOwner.selector, vendorId, rando)
        );
        attestations.vendorSignMetadata(vendorId);
    }

    function test_vendorSignMetadata_requiresMetadata() public {
        bytes32 bare = _registerBareVendor("bare.example");
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.NoMetadataToSign.selector, bare));
        attestations.vendorSignMetadata(bare);
    }

    function test_vendorSignMetadata_invalidatedByMetadataChange() public {
        vm.prank(vendorOwner);
        bytes32 id = attestations.vendorSignMetadata(vendorId);
        assertEq(attestations.verificationLevel(vendorId), 4);

        // vendor republishes metadata -> signature no longer covers anchored hash
        vm.prank(vendorOwner);
        registry.setMetadata(vendorId, keccak256("metadata-v2"), "uri2");
        assertFalse(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 0);

        // re-signing restores level 4
        vm.prank(vendorOwner);
        attestations.vendorSignMetadata(vendorId);
        assertEq(attestations.verificationLevel(vendorId), 4);
    }

    function _registerBareVendor(string memory domain) internal returns (bytes32 id) {
        string[] memory extra = new string[](0);
        address[] memory none = new address[](0);
        vm.prank(otherOwner);
        id = registry.registerVendor(domain, extra, none, "", bytes32(0), "");
    }

    // -----------------------------------------------------------------
    // Revocation & attester bans
    // -----------------------------------------------------------------

    function test_revokeAttestation_byAttester() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(365));

        vm.prank(verifier);
        attestations.revokeAttestation(id, "issued in error");
        assertFalse(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 0);
    }

    function test_revokeAttestation_byAdmin_notByRando() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(365));

        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.NotAttesterNorAdmin.selector, id, rando)
        );
        attestations.revokeAttestation(id, "grief");

        vm.prank(admin);
        attestations.revokeAttestation(id, "verifier misconduct");
        assertFalse(attestations.isAttestationActive(id));
    }

    function test_revokeAttestation_twice_reverts() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(365));
        vm.prank(verifier);
        attestations.revokeAttestation(id, "x");
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.AlreadyRevoked.selector, id));
        attestations.revokeAttestation(id, "x");
    }

    function test_banAttester_invalidatesPriorIssuance_notLater() public {
        vm.prank(verifier);
        bytes32 before_ = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(365));
        uint64 cutoff = uint64(block.timestamp);

        // compromise discovered: ban everything issued up to now
        vm.prank(admin);
        attestations.banAttester(verifier, cutoff);
        assertFalse(attestations.isAttestationActive(before_));
        assertEq(attestations.verificationLevel(vendorId), 0);

        // verifier rotates key / is re-trusted; new issuance after cutoff is active
        vm.warp(block.timestamp + 1 hours);
        vm.prank(verifier);
        bytes32 after_ = attestations.attest(vendorId, T_DOMAIN, keccak256("e2"), _expiry(365));
        assertTrue(attestations.isAttestationActive(after_));
        assertEq(attestations.verificationLevel(vendorId), 1);
    }

    function test_banAttester_onlyAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        attestations.banAttester(verifier, uint64(block.timestamp));
    }

    // -----------------------------------------------------------------
    // Enumeration / misc
    // -----------------------------------------------------------------

    function test_enumeration() public {
        vm.startPrank(verifier);
        bytes32 a1 = attestations.attest(vendorId, T_DOMAIN, keccak256("e1"), _expiry(30));
        bytes32 a2 = attestations.attest(vendorId, T_WALLET, keccak256("e2"), _expiry(30));
        vm.stopPrank();

        assertEq(attestations.attestationCountOf(vendorId), 2);
        assertEq(attestations.attestationIdOfVendorAt(vendorId, 0), a1);
        assertEq(attestations.attestationIdOfVendorAt(vendorId, 1), a2);
        assertEq(attestations.latestAttestationId(vendorId, T_WALLET), a2);
    }

    function test_getAttestation_unknown_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.AttestationNotFound.selector, bytes32(uint256(1)))
        );
        attestations.getAttestation(bytes32(uint256(1)));
    }

    function test_attestationIds_uniquePerChainAndContract() public {
        vm.prank(verifier);
        bytes32 id1 = attestations.attest(vendorId, T_DOMAIN, keccak256("e"), _expiry(30));
        assertEq(id1, keccak256(abi.encode(block.chainid, address(attestations), uint256(1))));
    }
}
