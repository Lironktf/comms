// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IVendorRegistry — canonical vendor identity for agentic commerce (ACTP V1)
interface IVendorRegistry {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// Vendor lifecycle. Transitions: None -> Active <-> Suspended -> Revoked.
    /// Active -> Revoked is also allowed. Revoked is terminal; identifiers
    /// (vendorId, domains, wallets) of a revoked vendor are permanently
    /// quarantined and can never be re-registered.
    enum VendorStatus {
        None,
        Active,
        Suspended,
        Revoked
    }

    struct VendorView {
        bytes32 vendorId;
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

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event VendorRegistered(
        bytes32 indexed vendorId, address indexed owner, string primaryDomain, uint64 registeredAt
    );
    event VendorStatusChanged(
        bytes32 indexed vendorId, VendorStatus indexed oldStatus, VendorStatus indexed newStatus, string reason
    );
    event VendorOwnershipTransferStarted(
        bytes32 indexed vendorId, address indexed currentOwner, address indexed pendingOwner
    );
    event VendorOwnershipTransferred(bytes32 indexed vendorId, address indexed oldOwner, address indexed newOwner);
    event DomainAdded(bytes32 indexed vendorId, string domain);
    event DomainRemoved(bytes32 indexed vendorId, string domain);
    event WalletAdded(bytes32 indexed vendorId, address indexed wallet);
    event WalletRemoved(bytes32 indexed vendorId, address indexed wallet);
    event X402EndpointUpdated(bytes32 indexed vendorId, string endpoint);
    event MetadataUpdated(bytes32 indexed vendorId, uint64 indexed version, bytes32 metadataHash, string metadataURI);
    event ContractMetadataUpdated(bytes32 indexed vendorId, uint64 indexed version, bytes32 contractMetadataHash);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error VendorAlreadyRegistered(bytes32 vendorId);
    error VendorNotFound(bytes32 vendorId);
    error VendorNotActive(bytes32 vendorId);
    error VendorRevokedError(bytes32 vendorId);
    error NotVendorOwner(bytes32 vendorId, address caller);
    error NotPendingOwner(bytes32 vendorId, address caller);
    error DomainAlreadyClaimed(string domain, bytes32 claimedBy);
    error WalletAlreadyClaimed(address wallet, bytes32 claimedBy);
    error InvalidDomain(string domain);
    error InvalidWallet(address wallet);
    error DomainNotFound(string domain);
    error WalletNotFound(address wallet);
    error CannotRemovePrimaryDomain();
    error TooManyDomains(uint256 max);
    error TooManyWallets(uint256 max);
    error InvalidStatusTransition(VendorStatus from, VendorStatus to);
    error ZeroAddress();
    error ZeroHash();

    // ---------------------------------------------------------------------
    // Mutations
    // ---------------------------------------------------------------------

    function registerVendor(
        string calldata primaryDomain,
        string[] calldata extraDomains,
        address[] calldata wallets,
        string calldata x402Endpoint,
        bytes32 metadataHash,
        string calldata metadataURI
    ) external returns (bytes32 vendorId);

    function addDomain(bytes32 vendorId, string calldata domain) external;
    function removeDomain(bytes32 vendorId, string calldata domain) external;
    function addWallet(bytes32 vendorId, address wallet) external;
    function removeWallet(bytes32 vendorId, address wallet) external;
    function setX402Endpoint(bytes32 vendorId, string calldata endpoint) external;
    function setMetadata(bytes32 vendorId, bytes32 metadataHash, string calldata metadataURI) external;
    function setContractMetadataHash(bytes32 vendorId, bytes32 contractMetadataHash) external;

    function transferVendorOwnership(bytes32 vendorId, address newOwner) external;
    function acceptVendorOwnership(bytes32 vendorId) external;

    function suspendVendor(bytes32 vendorId, string calldata reason) external;
    function unsuspendVendor(bytes32 vendorId, string calldata reason) external;
    function revokeVendor(bytes32 vendorId, string calldata reason) external;

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function computeVendorId(string calldata primaryDomain) external pure returns (bytes32);
    function getVendor(bytes32 vendorId) external view returns (VendorView memory);
    function vendorStatus(bytes32 vendorId) external view returns (VendorStatus);
    function vendorOwner(bytes32 vendorId) external view returns (address);
    function metadataHashOf(bytes32 vendorId) external view returns (bytes32);
    function vendorIdForDomain(string calldata domain) external view returns (bytes32);
    function vendorIdForWallet(address wallet) external view returns (bytes32);
    function vendorCount() external view returns (uint256);
    function vendorIdAt(uint256 index) external view returns (bytes32);
}
