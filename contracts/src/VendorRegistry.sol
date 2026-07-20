// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IVendorRegistry} from "./interfaces/IVendorRegistry.sol";
import {DomainLib} from "./libraries/DomainLib.sol";

/// @title VendorRegistry — ACTP V1: canonical onchain vendor identity.
///
/// Registration is permissionless: anyone may register a vendor record for a domain, but a
/// record carries no trust until attestations exist in the AttestationRegistry (V2). Trust
/// consumers MUST combine registry state with verification level; a bare record proves nothing.
///
/// Governance model (documented in docs/trust-assumptions.md):
///  - DEFAULT_ADMIN_ROLE: intended for a Safe multisig (+ timelock post-MVP). Manages roles.
///  - GUARDIAN_ROLE:      may suspend/unsuspend/revoke vendors (abuse response).
///  - PAUSER_ROLE:        may pause registration and vendor mutations (incident response).
///  - UPGRADER_ROLE:      may authorize UUPS upgrades.
/// All powers are evented; nothing can be silently mutated.
contract VendorRegistry is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    IVendorRegistry
{
    using DomainLib for string;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// Domain separator baked into vendor IDs so they can never collide with IDs of other
    /// schemes or future versions.
    bytes32 public constant VENDOR_ID_SCHEME = keccak256("actp.vendor.v1");

    uint256 public constant MAX_DOMAINS = 16;
    uint256 public constant MAX_WALLETS = 16;

    struct Vendor {
        address owner;
        address pendingOwner;
        VendorStatus status;
        uint64 registeredAt;
        uint64 updatedAt;
        uint64 metadataVersion;
        uint64 contractMetadataVersion;
        bytes32 metadataHash;
        bytes32 contractMetadataHash;
        string metadataURI;
        string primaryDomain;
        string x402Endpoint;
        string[] domains;
        address[] wallets;
    }

    /// @custom:storage-location erc7201:actp.storage.VendorRegistry
    struct VendorRegistryStorage {
        mapping(bytes32 vendorId => Vendor) vendors;
        // Uniqueness claims. Claims of revoked vendors are intentionally never released:
        // a revoked identity's domains/wallets stay quarantined forever.
        mapping(bytes32 domainHash => bytes32 vendorId) domainClaims;
        mapping(address wallet => bytes32 vendorId) walletClaims;
        bytes32[] vendorIds;
    }

    // keccak256(abi.encode(uint256(keccak256("actp.storage.VendorRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xc335679962c48ea6a3ef0340a68d36f07aa2d256bc3bebfbf885fbbf0a245400;

    function _s() private pure returns (VendorRegistryStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Modifiers / internal guards
    // ---------------------------------------------------------------------

    modifier onlyVendorOwner(bytes32 vendorId) {
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.None) revert VendorNotFound(vendorId);
        if (v.owner != msg.sender) revert NotVendorOwner(vendorId, msg.sender);
        _;
    }

    /// Owner mutations require an Active vendor: suspended vendors are frozen (they can still
    /// accept/complete ownership transfer so a compromised-key recovery remains possible).
    modifier onlyActiveVendorOwner(bytes32 vendorId) {
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.None) revert VendorNotFound(vendorId);
        if (v.owner != msg.sender) revert NotVendorOwner(vendorId, msg.sender);
        if (v.status != VendorStatus.Active) revert VendorNotActive(vendorId);
        _;
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    /// @inheritdoc IVendorRegistry
    function registerVendor(
        string calldata primaryDomain,
        string[] calldata extraDomains,
        address[] calldata wallets,
        string calldata x402Endpoint,
        bytes32 metadataHash,
        string calldata metadataURI
    ) external whenNotPaused returns (bytes32 vendorId) {
        vendorId = _computeVendorId(primaryDomain);

        VendorRegistryStorage storage $ = _s();
        // Covers both live records and revoked (terminal) records: a revoked vendorId is
        // never re-registrable.
        if ($.vendors[vendorId].status != VendorStatus.None) revert VendorAlreadyRegistered(vendorId);
        if (extraDomains.length + 1 > MAX_DOMAINS) revert TooManyDomains(MAX_DOMAINS);
        if (wallets.length > MAX_WALLETS) revert TooManyWallets(MAX_WALLETS);

        Vendor storage v = $.vendors[vendorId];
        v.owner = msg.sender;
        v.status = VendorStatus.Active;
        v.registeredAt = uint64(block.timestamp);
        v.updatedAt = uint64(block.timestamp);
        v.primaryDomain = primaryDomain;
        v.x402Endpoint = x402Endpoint;
        $.vendorIds.push(vendorId);

        emit VendorRegistered(vendorId, msg.sender, primaryDomain, uint64(block.timestamp));

        // Every claim emits its event so the registry is fully reconstructible from the log.
        _claimDomain($, v, vendorId, primaryDomain);
        emit DomainAdded(vendorId, primaryDomain);
        for (uint256 i = 0; i < extraDomains.length; i++) {
            _claimDomain($, v, vendorId, extraDomains[i]);
            emit DomainAdded(vendorId, extraDomains[i]);
        }
        for (uint256 i = 0; i < wallets.length; i++) {
            _claimWallet($, v, vendorId, wallets[i]);
            emit WalletAdded(vendorId, wallets[i]);
        }

        if (bytes(x402Endpoint).length != 0) emit X402EndpointUpdated(vendorId, x402Endpoint);

        if (metadataHash != bytes32(0)) {
            v.metadataHash = metadataHash;
            v.metadataURI = metadataURI;
            v.metadataVersion = 1;
            emit MetadataUpdated(vendorId, 1, metadataHash, metadataURI);
        }
    }

    // ---------------------------------------------------------------------
    // Vendor-owner mutations
    // ---------------------------------------------------------------------

    function addDomain(bytes32 vendorId, string calldata domain)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        VendorRegistryStorage storage $ = _s();
        Vendor storage v = $.vendors[vendorId];
        if (v.domains.length + 1 > MAX_DOMAINS) revert TooManyDomains(MAX_DOMAINS);
        _claimDomain($, v, vendorId, domain);
        _touch(v);
        emit DomainAdded(vendorId, domain);
    }

    function removeDomain(bytes32 vendorId, string calldata domain)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        VendorRegistryStorage storage $ = _s();
        Vendor storage v = $.vendors[vendorId];
        bytes32 dh = domain.hash();
        if (keccak256(bytes(v.primaryDomain)) == dh) revert CannotRemovePrimaryDomain();
        if ($.domainClaims[dh] != vendorId) revert DomainNotFound(domain);

        delete $.domainClaims[dh];
        _removeString(v.domains, dh);
        _touch(v);
        emit DomainRemoved(vendorId, domain);
    }

    function addWallet(bytes32 vendorId, address wallet)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        VendorRegistryStorage storage $ = _s();
        Vendor storage v = $.vendors[vendorId];
        if (v.wallets.length + 1 > MAX_WALLETS) revert TooManyWallets(MAX_WALLETS);
        _claimWallet($, v, vendorId, wallet);
        _touch(v);
        emit WalletAdded(vendorId, wallet);
    }

    function removeWallet(bytes32 vendorId, address wallet)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        VendorRegistryStorage storage $ = _s();
        Vendor storage v = $.vendors[vendorId];
        if ($.walletClaims[wallet] != vendorId) revert WalletNotFound(wallet);

        delete $.walletClaims[wallet];
        uint256 len = v.wallets.length;
        for (uint256 i = 0; i < len; i++) {
            if (v.wallets[i] == wallet) {
                v.wallets[i] = v.wallets[len - 1];
                v.wallets.pop();
                break;
            }
        }
        _touch(v);
        emit WalletRemoved(vendorId, wallet);
    }

    function setX402Endpoint(bytes32 vendorId, string calldata endpoint)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        Vendor storage v = _s().vendors[vendorId];
        v.x402Endpoint = endpoint;
        _touch(v);
        emit X402EndpointUpdated(vendorId, endpoint);
    }

    /// @notice Anchor a new version of the offchain metadata document (ACTP V3).
    /// @dev `metadataHash` MUST be keccak256 of the RFC 8785 (JCS) canonicalized JSON document.
    ///      Anchoring a new hash invalidates any VendorSigned attestation over the old hash
    ///      (enforced by the AttestationRegistry's activity check).
    function setMetadata(bytes32 vendorId, bytes32 metadataHash, string calldata metadataURI)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        if (metadataHash == bytes32(0)) revert ZeroHash();
        Vendor storage v = _s().vendors[vendorId];
        v.metadataHash = metadataHash;
        v.metadataURI = metadataURI;
        v.metadataVersion += 1;
        _touch(v);
        emit MetadataUpdated(vendorId, v.metadataVersion, metadataHash, metadataURI);
    }

    /// @notice Anchor a new version of the offchain contract-terms document (ACTP V4).
    function setContractMetadataHash(bytes32 vendorId, bytes32 contractMetadataHash)
        external
        whenNotPaused
        onlyActiveVendorOwner(vendorId)
    {
        if (contractMetadataHash == bytes32(0)) revert ZeroHash();
        Vendor storage v = _s().vendors[vendorId];
        v.contractMetadataHash = contractMetadataHash;
        v.contractMetadataVersion += 1;
        _touch(v);
        emit ContractMetadataUpdated(vendorId, v.contractMetadataVersion, contractMetadataHash);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer (two-step)
    // ---------------------------------------------------------------------

    function transferVendorOwnership(bytes32 vendorId, address newOwner)
        external
        whenNotPaused
        onlyVendorOwner(vendorId)
    {
        if (newOwner == address(0)) revert ZeroAddress();
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.Revoked) revert VendorRevokedError(vendorId);
        v.pendingOwner = newOwner;
        emit VendorOwnershipTransferStarted(vendorId, v.owner, newOwner);
    }

    function acceptVendorOwnership(bytes32 vendorId) external whenNotPaused {
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.None) revert VendorNotFound(vendorId);
        if (v.status == VendorStatus.Revoked) revert VendorRevokedError(vendorId);
        if (v.pendingOwner != msg.sender) revert NotPendingOwner(vendorId, msg.sender);
        address old = v.owner;
        v.owner = msg.sender;
        v.pendingOwner = address(0);
        _touch(v);
        emit VendorOwnershipTransferred(vendorId, old, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Guardian lifecycle controls
    // ---------------------------------------------------------------------

    function suspendVendor(bytes32 vendorId, string calldata reason) external onlyRole(GUARDIAN_ROLE) {
        _transitionStatus(vendorId, VendorStatus.Suspended, reason);
    }

    function unsuspendVendor(bytes32 vendorId, string calldata reason) external onlyRole(GUARDIAN_ROLE) {
        _transitionStatus(vendorId, VendorStatus.Active, reason);
    }

    /// @notice Terminal removal. The vendorId and all its claimed domains/wallets are
    ///         permanently quarantined. Callable by the guardian (abuse) or the vendor
    ///         owner (self-exit).
    function revokeVendor(bytes32 vendorId, string calldata reason) external {
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.None) revert VendorNotFound(vendorId);
        if (msg.sender != v.owner && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotVendorOwner(vendorId, msg.sender);
        }
        _transitionStatus(vendorId, VendorStatus.Revoked, reason);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function computeVendorId(string calldata primaryDomain) external pure returns (bytes32) {
        return _computeVendorId(primaryDomain);
    }

    function getVendor(bytes32 vendorId) external view returns (VendorView memory out) {
        Vendor storage v = _s().vendors[vendorId];
        if (v.status == VendorStatus.None) revert VendorNotFound(vendorId);
        out = VendorView({
            vendorId: vendorId,
            owner: v.owner,
            pendingOwner: v.pendingOwner,
            status: v.status,
            registeredAt: v.registeredAt,
            updatedAt: v.updatedAt,
            metadataVersion: v.metadataVersion,
            contractMetadataVersion: v.contractMetadataVersion,
            metadataHash: v.metadataHash,
            contractMetadataHash: v.contractMetadataHash,
            metadataURI: v.metadataURI,
            primaryDomain: v.primaryDomain,
            x402Endpoint: v.x402Endpoint,
            domains: v.domains,
            wallets: v.wallets
        });
    }

    function vendorStatus(bytes32 vendorId) external view returns (VendorStatus) {
        return _s().vendors[vendorId].status;
    }

    function vendorOwner(bytes32 vendorId) external view returns (address) {
        return _s().vendors[vendorId].owner;
    }

    function metadataHashOf(bytes32 vendorId) external view returns (bytes32) {
        return _s().vendors[vendorId].metadataHash;
    }

    function vendorIdForDomain(string calldata domain) external view returns (bytes32) {
        return _s().domainClaims[domain.hash()];
    }

    function vendorIdForWallet(address wallet) external view returns (bytes32) {
        return _s().walletClaims[wallet];
    }

    function vendorCount() external view returns (uint256) {
        return _s().vendorIds.length;
    }

    function vendorIdAt(uint256 index) external view returns (bytes32) {
        return _s().vendorIds[index];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _computeVendorId(string calldata primaryDomain) internal pure returns (bytes32) {
        if (!DomainLib.isValid(primaryDomain)) revert InvalidDomain(primaryDomain);
        return keccak256(abi.encode(VENDOR_ID_SCHEME, keccak256(bytes(primaryDomain))));
    }

    function _claimDomain(
        VendorRegistryStorage storage $,
        Vendor storage v,
        bytes32 vendorId,
        string calldata domain
    ) private {
        if (!DomainLib.isValid(domain)) revert InvalidDomain(domain);
        bytes32 dh = domain.hash();
        bytes32 existing = $.domainClaims[dh];
        if (existing != bytes32(0)) revert DomainAlreadyClaimed(domain, existing);
        $.domainClaims[dh] = vendorId;
        v.domains.push(domain);
    }

    function _claimWallet(
        VendorRegistryStorage storage $,
        Vendor storage v,
        bytes32 vendorId,
        address wallet
    ) private {
        if (wallet == address(0)) revert InvalidWallet(wallet);
        bytes32 existing = $.walletClaims[wallet];
        if (existing != bytes32(0)) revert WalletAlreadyClaimed(wallet, existing);
        $.walletClaims[wallet] = vendorId;
        v.wallets.push(wallet);
    }

    function _removeString(string[] storage arr, bytes32 targetHash) private {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (keccak256(bytes(arr[i])) == targetHash) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    /// Enforces the status state machine:
    ///   Active    -> Suspended | Revoked
    ///   Suspended -> Active    | Revoked
    ///   Revoked   -> (terminal)
    function _transitionStatus(bytes32 vendorId, VendorStatus to, string calldata reason) private {
        Vendor storage v = _s().vendors[vendorId];
        VendorStatus from = v.status;
        if (from == VendorStatus.None) revert VendorNotFound(vendorId);

        bool ok = (from == VendorStatus.Active && (to == VendorStatus.Suspended || to == VendorStatus.Revoked))
            || (from == VendorStatus.Suspended && (to == VendorStatus.Active || to == VendorStatus.Revoked));
        if (!ok) revert InvalidStatusTransition(from, to);

        v.status = to;
        _touch(v);
        emit VendorStatusChanged(vendorId, from, to, reason);
    }

    function _touch(Vendor storage v) private {
        v.updatedAt = uint64(block.timestamp);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
