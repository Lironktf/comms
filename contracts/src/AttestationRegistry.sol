// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IVendorRegistry} from "./interfaces/IVendorRegistry.sol";

/// @title AttestationRegistry — ACTP V2: graduated vendor verification via signed attestations.
///
/// Verification levels are a projection of the live attestation set, never stored directly:
///   0 Unverified          — no active attestations
///   1 DomainVerified      — verifier attested control of the vendor's listed domains
///   2 WalletVerified      — verifier attested control of the vendor's payout wallets
///   3 LegalEntityVerified — verifier attested a KYB check of the legal entity
///   4 VendorSigned        — the vendor owner key signed the current metadata hash
///   5 Audited             — accredited auditor attestation
///
/// Because the level is computed from attestations that expire, are revocable per-attestation
/// and per-verifier (compromise response), and — for VendorSigned — bind to the *current*
/// metadata hash, trust degrades automatically instead of rotting silently.
contract AttestationRegistry is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    EIP712Upgradeable
{
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum AttestationType {
        None, // 0 — unused
        DomainVerified, // 1
        WalletVerified, // 2
        LegalEntityVerified, // 3
        VendorSigned, // 4 — issued by the vendor owner, not a verifier
        Audited // 5
    }

    struct Attestation {
        bytes32 vendorId;
        AttestationType attType;
        bytes32 evidenceHash; // content hash of offchain evidence (challenge log, KYB report id, audit report)
        uint64 issuedAt;
        uint64 expiresAt;
        address attester;
        bool revoked;
    }

    /// EIP-712 payload for verifier-signed attestations submitted by a relayer.
    struct AttestationRequest {
        bytes32 vendorId;
        uint8 attType;
        bytes32 evidenceHash;
        uint64 expiresAt;
        uint256 nonce; // must equal nonces[signer]; consumed on use
        uint256 deadline; // signature submission deadline
    }

    // ---------------------------------------------------------------------
    // Roles / constants
    // ---------------------------------------------------------------------

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant VERIFIER_ADMIN_ROLE = keccak256("VERIFIER_ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    bytes32 public constant ATTESTATION_REQUEST_TYPEHASH = keccak256(
        "AttestationRequest(bytes32 vendorId,uint8 attType,bytes32 evidenceHash,uint64 expiresAt,uint256 nonce,uint256 deadline)"
    );

    /// Attestations may not be issued with a validity window longer than this.
    uint64 public constant MAX_VALIDITY = 730 days;
    /// Validity of a VendorSigned metadata attestation.
    uint64 public constant VENDOR_SIGNED_VALIDITY = 365 days;

    // ---------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------

    event Attested(
        bytes32 indexed attestationId,
        bytes32 indexed vendorId,
        AttestationType indexed attType,
        address attester,
        bytes32 evidenceHash,
        uint64 issuedAt,
        uint64 expiresAt
    );
    event AttestationRevoked(bytes32 indexed attestationId, address indexed revokedBy, string reason);
    event AttesterBanned(address indexed attester, uint64 issuedAtCutoff);

    error VendorNotFoundOrInactive(bytes32 vendorId);
    error InvalidAttestationType(uint8 attType);
    error InvalidExpiry(uint64 expiresAt);
    error AttestationNotFound(bytes32 attestationId);
    error AlreadyRevoked(bytes32 attestationId);
    error NotAttesterNorAdmin(bytes32 attestationId, address caller);
    error SignatureExpired(uint256 deadline);
    error InvalidNonce(uint256 expected, uint256 got);
    error SignerNotVerifier(address signer);
    error NotVendorOwner(bytes32 vendorId, address caller);
    error NoMetadataToSign(bytes32 vendorId);
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Storage (ERC-7201)
    // ---------------------------------------------------------------------

    /// @custom:storage-location erc7201:actp.storage.AttestationRegistry
    struct AttestationRegistryStorage {
        IVendorRegistry vendorRegistry;
        uint256 attestationCounter;
        mapping(bytes32 attestationId => Attestation) attestations;
        // Latest attestation per (vendor, type): the record consulted for level computation.
        mapping(bytes32 vendorId => mapping(AttestationType => bytes32)) latestByType;
        // All attestation ids per vendor (enumeration for indexers/auditors).
        mapping(bytes32 vendorId => bytes32[]) vendorAttestations;
        // Replay protection for signature-relayed attestations.
        mapping(address attester => uint256) nonces;
        // Compromise response: attestations issued by `attester` at or before this timestamp
        // are considered inactive. 0 = no ban.
        mapping(address attester => uint64) attesterBanCutoff;
    }

    // keccak256(abi.encode(uint256(keccak256("actp.storage.AttestationRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x42c97fc50d573fbff08fa326e0386070a90743928d859ffe4ab123a76d9a5100;

    function _s() private pure returns (AttestationRegistryStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, IVendorRegistry registry) external initializer {
        if (admin == address(0) || address(registry) == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __EIP712_init("ACTP AttestationRegistry", "1");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        // VERIFIER_ROLE is administered by VERIFIER_ADMIN_ROLE, not DEFAULT_ADMIN_ROLE,
        // so verifier onboarding can be delegated without handing out full admin.
        _setRoleAdmin(VERIFIER_ROLE, VERIFIER_ADMIN_ROLE);
        _s().vendorRegistry = registry;
    }

    // ---------------------------------------------------------------------
    // Attestation issuance
    // ---------------------------------------------------------------------

    /// @notice Direct issuance by an address holding VERIFIER_ROLE.
    function attest(bytes32 vendorId, uint8 attType, bytes32 evidenceHash, uint64 expiresAt)
        external
        onlyRole(VERIFIER_ROLE)
        returns (bytes32 attestationId)
    {
        return _issue(vendorId, attType, evidenceHash, expiresAt, msg.sender);
    }

    /// @notice Relayed issuance: anyone may submit an EIP-712 attestation signed by a verifier.
    ///         Replay-safe via per-signer sequential nonces; bound to this contract and chain
    ///         by the EIP-712 domain.
    function attestWithSignature(AttestationRequest calldata req, bytes calldata signature)
        external
        returns (bytes32 attestationId)
    {
        if (block.timestamp > req.deadline) revert SignatureExpired(req.deadline);

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_REQUEST_TYPEHASH,
                    req.vendorId,
                    req.attType,
                    req.evidenceHash,
                    req.expiresAt,
                    req.nonce,
                    req.deadline
                )
            )
        );
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(VERIFIER_ROLE, signer)) revert SignerNotVerifier(signer);

        AttestationRegistryStorage storage $ = _s();
        uint256 expected = $.nonces[signer];
        if (req.nonce != expected) revert InvalidNonce(expected, req.nonce);
        $.nonces[signer] = expected + 1;

        return _issue(req.vendorId, req.attType, req.evidenceHash, req.expiresAt, signer);
    }

    /// @notice ACTP level 4: the vendor owner signs (by transacting) the currently anchored
    ///         metadata hash. The attestation stays active only while the anchored hash is
    ///         unchanged — republishing metadata requires re-signing.
    function vendorSignMetadata(bytes32 vendorId) external returns (bytes32 attestationId) {
        AttestationRegistryStorage storage $ = _s();
        IVendorRegistry reg = $.vendorRegistry;
        if (reg.vendorStatus(vendorId) != IVendorRegistry.VendorStatus.Active) {
            revert VendorNotFoundOrInactive(vendorId);
        }
        if (reg.vendorOwner(vendorId) != msg.sender) revert NotVendorOwner(vendorId, msg.sender);
        bytes32 metadataHash = reg.metadataHashOf(vendorId);
        if (metadataHash == bytes32(0)) revert NoMetadataToSign(vendorId);

        return _record(
            vendorId,
            AttestationType.VendorSigned,
            metadataHash,
            uint64(block.timestamp) + VENDOR_SIGNED_VALIDITY,
            msg.sender
        );
    }

    // ---------------------------------------------------------------------
    // Revocation
    // ---------------------------------------------------------------------

    /// @notice Revoke a single attestation. Allowed for its issuer (correction/withdrawal)
    ///         or the verifier admin (abuse response).
    function revokeAttestation(bytes32 attestationId, string calldata reason) external {
        AttestationRegistryStorage storage $ = _s();
        Attestation storage a = $.attestations[attestationId];
        if (a.issuedAt == 0) revert AttestationNotFound(attestationId);
        if (a.revoked) revert AlreadyRevoked(attestationId);
        if (msg.sender != a.attester && !hasRole(VERIFIER_ADMIN_ROLE, msg.sender)) {
            revert NotAttesterNorAdmin(attestationId, msg.sender);
        }
        a.revoked = true;
        emit AttestationRevoked(attestationId, msg.sender, reason);
    }

    /// @notice Compromise response: invalidate every attestation issued by `attester` at or
    ///         before `issuedAtCutoff` in O(1), without enumerating them. Typically combined
    ///         with revoking the attester's VERIFIER_ROLE.
    function banAttester(address attester, uint64 issuedAtCutoff)
        external
        onlyRole(VERIFIER_ADMIN_ROLE)
    {
        _s().attesterBanCutoff[attester] = issuedAtCutoff;
        emit AttesterBanned(attester, issuedAtCutoff);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getAttestation(bytes32 attestationId) external view returns (Attestation memory a) {
        a = _s().attestations[attestationId];
        if (a.issuedAt == 0) revert AttestationNotFound(attestationId);
    }

    /// @notice An attestation is active iff it exists, is unrevoked, unexpired, its issuer is
    ///         not banned for its issuance window, its vendor is Active, and — for
    ///         VendorSigned — it still matches the currently anchored metadata hash.
    function isAttestationActive(bytes32 attestationId) public view returns (bool) {
        AttestationRegistryStorage storage $ = _s();
        Attestation storage a = $.attestations[attestationId];
        if (a.issuedAt == 0 || a.revoked) return false;
        if (block.timestamp >= a.expiresAt) return false;
        uint64 cutoff = $.attesterBanCutoff[a.attester];
        if (cutoff != 0 && a.issuedAt <= cutoff) return false;
        IVendorRegistry reg = $.vendorRegistry;
        if (reg.vendorStatus(a.vendorId) != IVendorRegistry.VendorStatus.Active) return false;
        if (a.attType == AttestationType.VendorSigned && reg.metadataHashOf(a.vendorId) != a.evidenceHash) {
            return false;
        }
        return true;
    }

    /// @notice Computed verification level: the highest attestation type whose most recent
    ///         attestation is currently active. (If a newer attestation of a type was revoked
    ///         while an older one is still valid, the type reads inactive until re-attested —
    ///         a deliberate fail-closed choice.)
    function verificationLevel(bytes32 vendorId) external view returns (uint8) {
        AttestationRegistryStorage storage $ = _s();
        for (uint8 t = uint8(AttestationType.Audited); t >= uint8(AttestationType.DomainVerified); t--) {
            bytes32 id = $.latestByType[vendorId][AttestationType(t)];
            if (id != bytes32(0) && isAttestationActive(id)) return t;
        }
        return 0;
    }

    /// @notice True iff the vendor holds an active attestation of the given type.
    function hasActiveAttestation(bytes32 vendorId, uint8 attType) external view returns (bool) {
        if (attType == 0 || attType > uint8(AttestationType.Audited)) return false;
        bytes32 id = _s().latestByType[vendorId][AttestationType(attType)];
        return id != bytes32(0) && isAttestationActive(id);
    }

    function latestAttestationId(bytes32 vendorId, uint8 attType) external view returns (bytes32) {
        return _s().latestByType[vendorId][AttestationType(attType)];
    }

    function attestationCountOf(bytes32 vendorId) external view returns (uint256) {
        return _s().vendorAttestations[vendorId].length;
    }

    function attestationIdOfVendorAt(bytes32 vendorId, uint256 index) external view returns (bytes32) {
        return _s().vendorAttestations[vendorId][index];
    }

    function nonceOf(address attester) external view returns (uint256) {
        return _s().nonces[attester];
    }

    function attesterBanCutoffOf(address attester) external view returns (uint64) {
        return _s().attesterBanCutoff[attester];
    }

    function vendorRegistry() external view returns (IVendorRegistry) {
        return _s().vendorRegistry;
    }

    /// @notice Exposed EIP-712 digest helper so verifiers/offchain tooling can build
    ///         signatures without reimplementing the domain.
    function hashAttestationRequest(AttestationRequest calldata req) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_REQUEST_TYPEHASH,
                    req.vendorId,
                    req.attType,
                    req.evidenceHash,
                    req.expiresAt,
                    req.nonce,
                    req.deadline
                )
            )
        );
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _issue(bytes32 vendorId, uint8 attType, bytes32 evidenceHash, uint64 expiresAt, address attester)
        private
        returns (bytes32)
    {
        // Verifiers may issue types 1,2,3,5. Type 4 (VendorSigned) is reserved for the vendor
        // owner via vendorSignMetadata.
        if (
            attType == uint8(AttestationType.None) || attType == uint8(AttestationType.VendorSigned)
                || attType > uint8(AttestationType.Audited)
        ) revert InvalidAttestationType(attType);
        return _record(vendorId, AttestationType(attType), evidenceHash, expiresAt, attester);
    }

    function _record(
        bytes32 vendorId,
        AttestationType attType,
        bytes32 evidenceHash,
        uint64 expiresAt,
        address attester
    ) private returns (bytes32 attestationId) {
        AttestationRegistryStorage storage $ = _s();
        if ($.vendorRegistry.vendorStatus(vendorId) != IVendorRegistry.VendorStatus.Active) {
            revert VendorNotFoundOrInactive(vendorId);
        }
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_VALIDITY) {
            revert InvalidExpiry(expiresAt);
        }

        uint256 seq = ++$.attestationCounter;
        attestationId = keccak256(abi.encode(block.chainid, address(this), seq));

        $.attestations[attestationId] = Attestation({
            vendorId: vendorId,
            attType: attType,
            evidenceHash: evidenceHash,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            attester: attester,
            revoked: false
        });
        $.latestByType[vendorId][attType] = attestationId;
        $.vendorAttestations[vendorId].push(attestationId);

        emit Attested(
            attestationId, vendorId, attType, attester, evidenceHash, uint64(block.timestamp), expiresAt
        );
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
