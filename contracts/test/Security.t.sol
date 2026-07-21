// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./helpers/BaseTest.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {VendorRegistry} from "../src/VendorRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";

/// Adversarial / security-focused tests: signature attacks, exhaustive access control,
/// pausable, reinit protection, boundary conditions, and lifecycle/quarantine abuse.
contract SecurityTest is BaseTest {
    // secp256k1 group order (for malleability construction)
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 internal vendorId;
    uint8 constant T_LEGAL = 3;

    function setUp() public override {
        super.setUp();
        vendorId = _registerVendor(vendorOwner, DOMAIN);
    }

    function _req(uint8 attType, uint256 nonce, uint64 expiresAt)
        internal
        view
        returns (AttestationRegistry.AttestationRequest memory)
    {
        return AttestationRegistry.AttestationRequest({
            vendorId: vendorId,
            attType: attType,
            evidenceHash: keccak256("evidence"),
            expiresAt: expiresAt,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    // ------------------------------------------------------------------ EIP-712 signature security

    function test_sig_crossChainReplay_rejected() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes memory sig = _signAttestation(verifierPk, req);
        // move to a different chain: the domain separator (chainId-bound) changes, so the
        // signature no longer recovers to the verifier
        vm.chainId(999999);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.SignerNotVerifier.selector, _wrongSigner(req, sig)));
        attestations.attestWithSignature(req, sig);
    }

    function test_sig_crossContractReplay_rejected() public {
        // a second, independent AttestationRegistry
        AttestationRegistry impl = new AttestationRegistry();
        AttestationRegistry att2 = AttestationRegistry(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(AttestationRegistry.initialize, (admin, IVendorRegistry(address(registry))))
                )
            )
        );
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes memory sig = _signAttestation(verifierPk, req); // domain = original `attestations`
        // replayed against att2 (different verifyingContract) -> recovers a different signer
        vm.expectRevert();
        att2.attestWithSignature(req, sig);
    }

    function test_sig_malleability_rejected() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes32 digest = attestations.hashAttestationRequest(req);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPk, digest);
        // flip to the high-s malleable counterpart; OZ ECDSA rejects it
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, sHigh, vFlip);
        vm.expectRevert();
        attestations.attestWithSignature(req, malleable);
    }

    function test_sig_nonceReplay_rejected() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes memory sig = _signAttestation(verifierPk, req);
        attestations.attestWithSignature(req, sig);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidNonce.selector, 1, 0));
        attestations.attestWithSignature(req, sig); // same sig again
    }

    function test_sig_tamperedAfterSigning_rejected() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes memory sig = _signAttestation(verifierPk, req);
        req.attType = 5; // escalate the attestation type after signing
        vm.expectRevert(); // digest changes -> recovered signer is not the verifier
        attestations.attestWithSignature(req, sig);
    }

    function test_sig_expiredDeadline_rejected() public {
        AttestationRegistry.AttestationRequest memory req = _req(T_LEGAL, 0, uint64(block.timestamp + 30 days));
        bytes memory sig = _signAttestation(verifierPk, req);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.SignatureExpired.selector, req.deadline));
        attestations.attestWithSignature(req, sig);
    }

    function _wrongSigner(AttestationRegistry.AttestationRequest memory req, bytes memory sig)
        internal
        view
        returns (address)
    {
        // recompute what the (now cross-chain) digest recovers to, to match the revert arg
        bytes32 digest = attestations.hashAttestationRequest(req);
        return _recover(digest, sig);
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ecrecover(digest, v, r, s);
    }

    // ------------------------------------------------------------------ access control exhaustiveness

    function test_access_vendorMutations_rejectNonOwner() public {
        vm.startPrank(rando);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.addDomain(vendorId, "x.example");
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.addWallet(vendorId, makeAddr("w"));
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.setMetadata(vendorId, keccak256("h"), "u");
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.setContractMetadataHash(vendorId, keccak256("h"));
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.setX402Endpoint(vendorId, "https://x");
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotVendorOwner.selector, vendorId, rando));
        registry.transferVendorOwnership(vendorId, rando);
        vm.stopPrank();
    }

    function test_access_lifecycle_requiresGuardian() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.suspendVendor(vendorId, "x");
        vm.prank(vendorOwner); // even the owner can't suspend (guardian only)
        vm.expectRevert();
        registry.suspendVendor(vendorId, "x");
    }

    function test_access_pause_requiresPauser() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.pause();
    }

    function test_access_attest_requiresVerifierRole() public {
        vm.prank(rando);
        vm.expectRevert();
        attestations.attest(vendorId, T_LEGAL, keccak256("e"), uint64(block.timestamp + 30 days));
    }

    function test_access_ban_requiresVerifierAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        attestations.banAttester(verifier, uint64(block.timestamp));
    }

    function test_access_verifierRole_lifecycle() public {
        address v2 = makeAddr("verifier2");
        bytes32 role = attestations.VERIFIER_ROLE();
        // non-admin cannot grant
        vm.prank(rando);
        vm.expectRevert();
        attestations.grantRole(role, v2);
        // admin grants -> works
        vm.prank(admin);
        attestations.grantRole(role, v2);
        vm.prank(v2);
        attestations.attest(vendorId, T_LEGAL, keccak256("e"), uint64(block.timestamp + 30 days));
        // admin revokes -> stops working
        vm.prank(admin);
        attestations.revokeRole(role, v2);
        vm.prank(v2);
        vm.expectRevert();
        attestations.attest(vendorId, 2, keccak256("e"), uint64(block.timestamp + 30 days));
    }

    // ------------------------------------------------------------------ pausable

    function test_pause_blocksAllVendorMutations_guardianStillWorks() public {
        vm.prank(admin);
        registry.pause();

        vm.startPrank(vendorOwner);
        vm.expectRevert();
        registry.addDomain(vendorId, "y.example");
        vm.expectRevert();
        registry.setMetadata(vendorId, keccak256("h"), "u");
        vm.expectRevert();
        registry.addWallet(vendorId, makeAddr("w2"));
        vm.stopPrank();

        // incident response still available while paused
        vm.prank(guardian);
        registry.suspendVendor(vendorId, "incident");
        assertEq(uint8(registry.vendorStatus(vendorId)), uint8(IVendorRegistry.VendorStatus.Suspended));
    }

    // ------------------------------------------------------------------ reinit protection

    function test_reinit_rejected() public {
        vm.expectRevert();
        registry.initialize(rando);
        vm.expectRevert();
        attestations.initialize(rando, IVendorRegistry(address(registry)));
    }

    function test_implementations_cannotBeInitialized() public {
        VendorRegistry vImpl = new VendorRegistry();
        AttestationRegistry aImpl = new AttestationRegistry();
        vm.expectRevert();
        vImpl.initialize(rando);
        vm.expectRevert();
        aImpl.initialize(rando, IVendorRegistry(address(registry)));
    }

    // ------------------------------------------------------------------ attestation boundary conditions

    function test_expiry_boundaries() public {
        vm.startPrank(verifier);
        // exactly now -> invalid
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidExpiry.selector, uint64(block.timestamp)));
        attestations.attest(vendorId, T_LEGAL, keccak256("e"), uint64(block.timestamp));
        // now + MAX_VALIDITY -> ok
        uint64 maxOk = uint64(block.timestamp) + attestations.MAX_VALIDITY();
        attestations.attest(vendorId, T_LEGAL, keccak256("e"), maxOk);
        // now + MAX_VALIDITY + 1 -> invalid
        uint64 tooFar = maxOk + 1;
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidExpiry.selector, tooFar));
        attestations.attest(vendorId, 2, keccak256("e"), tooFar);
        vm.stopPrank();
    }

    function test_active_deactivatesExactlyAtExpiry() public {
        uint64 exp = uint64(block.timestamp + 100);
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_LEGAL, keccak256("e"), exp);
        vm.warp(exp - 1);
        assertTrue(attestations.isAttestationActive(id));
        vm.warp(exp); // >= expiry is inactive
        assertFalse(attestations.isAttestationActive(id));
    }

    function test_banAttester_cutoffBoundary() public {
        vm.prank(verifier);
        bytes32 id = attestations.attest(vendorId, T_LEGAL, keccak256("e"), uint64(block.timestamp + 30 days));
        uint64 issuedAt = uint64(block.timestamp);
        // cutoff one second before issuance -> still active
        vm.prank(admin);
        attestations.banAttester(verifier, issuedAt - 1);
        assertTrue(attestations.isAttestationActive(id));
        // cutoff exactly at issuance -> banned (issued_at <= cutoff)
        vm.prank(admin);
        attestations.banAttester(verifier, issuedAt);
        assertFalse(attestations.isAttestationActive(id));
    }

    // ------------------------------------------------------------------ lifecycle / quarantine abuse

    function test_revoked_identifiersPermanentlyQuarantined() public {
        address w = registry.getVendor(vendorId).wallets[0];
        vm.prank(guardian);
        registry.revokeVendor(vendorId, "fraud");

        string[] memory extra = new string[](0);
        address[] memory none = new address[](0);
        // same primary domain -> same id -> blocked
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.VendorAlreadyRegistered.selector, vendorId));
        registry.registerVendor(DOMAIN, extra, none, "", bytes32(0), "");
        // wallet still claimed
        address[] memory ws = new address[](1);
        ws[0] = w;
        vm.prank(otherOwner);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.WalletAlreadyClaimed.selector, w, vendorId));
        registry.registerVendor("fresh.example", extra, ws, "", bytes32(0), "");
    }

    function test_revoked_cannotBeResurrected() public {
        vm.startPrank(guardian);
        registry.revokeVendor(vendorId, "gone");
        vm.expectRevert();
        registry.unsuspendVendor(vendorId, "no");
        vm.expectRevert();
        registry.suspendVendor(vendorId, "no");
        vm.stopPrank();
    }

    function test_ownership_cannotBeHijacked() public {
        vm.prank(vendorOwner);
        registry.transferVendorOwnership(vendorId, otherOwner);
        // a stranger cannot accept
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotPendingOwner.selector, vendorId, rando));
        registry.acceptVendorOwnership(vendorId);
        // owner can redirect the pending transfer before acceptance
        vm.prank(vendorOwner);
        registry.transferVendorOwnership(vendorId, rando);
        vm.prank(otherOwner); // the previously-pending owner is now stale
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.NotPendingOwner.selector, vendorId, otherOwner));
        registry.acceptVendorOwnership(vendorId);
        vm.prank(rando);
        registry.acceptVendorOwnership(vendorId);
        assertEq(registry.vendorOwner(vendorId), rando);
    }

    function test_domain_capEnforced() public {
        vm.startPrank(vendorOwner);
        // already has 1 (primary); add up to MAX_DOMAINS
        for (uint256 i = 1; i < registry.MAX_DOMAINS(); i++) {
            registry.addDomain(vendorId, string.concat("d", vm.toString(i), ".example"));
        }
        vm.expectRevert(abi.encodeWithSelector(IVendorRegistry.TooManyDomains.selector, registry.MAX_DOMAINS()));
        registry.addDomain(vendorId, "overflow.example");
        vm.stopPrank();
    }

    function test_vendorSigned_invalidatedByMetadataChange() public {
        vm.prank(vendorOwner);
        bytes32 id = attestations.vendorSignMetadata(vendorId);
        assertEq(attestations.verificationLevel(vendorId), 4);
        // republishing metadata breaks the signature binding
        vm.prank(vendorOwner);
        registry.setMetadata(vendorId, keccak256("metadata-v2"), "uri2");
        assertFalse(attestations.isAttestationActive(id));
        assertEq(attestations.verificationLevel(vendorId), 0);
    }
}
