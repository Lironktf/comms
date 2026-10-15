// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IVendorRegistry} from "@grayr/interfaces/IVendorRegistry.sol";
import {IAttestationLevels} from "./interfaces/IAttestationLevels.sol";
import {IVendorTree} from "./interfaces/IVendorTree.sol";
import {MerkleTree} from "./libraries/MerkleTree.sol";
import {ShieldedHashes} from "./libraries/ShieldedHashes.sol";
import {IPoseidon2} from "./interfaces/IPoseidon2.sol";

/// @title VendorTree — Grayr's verified-vendor Merkle root, readable by ZK circuits.
/// @notice Circuits can't call the AttestationRegistry, so this contract snapshots live
///         registry state into Poseidon2 leaves `H3(VENDOR, wallet, H3(level, categories, expiry))`
///         that a policy_pay proof opens privately ("I'm paying a level >= N vendor in an
///         allowed category" without saying which policy).
///
///         Publishing is PERMISSIONLESS and trustless: `publish` reads the vendor's status,
///         wallet binding and computed verification level from the deployed Grayr registries at
///         call time. Nobody can insert a leaf the registries don't back. Each leaf expires after
///         LEAF_TTL, so a demoted vendor's stale leaf stops working within LEAF_TTL; suspension
///         and revocation take effect IMMEDIATELY because the pool also live-checks
///         `isActiveVendorWallet(recipient)` (the recipient is public anyway).
///
///         Categories are not onchain in the VendorRegistry (they live in V3 metadata), so they
///         are attested here by holders of the AttestationRegistry's VERIFIER_ROLE: the same
///         parties already trusted to attest verification levels.
///
///         Built as a separate contract (instead of upgrading the deployed AttestationRegistry)
///         so the live Base Sepolia registries stay untouched; it only reads them.
contract VendorTree is AccessControl, IVendorTree {
    using MerkleTree for MerkleTree.Tree;

    IVendorRegistry public immutable registry;
    IAttestationLevels public immutable attestations;
    IPoseidon2 public immutable poseidon2;
    /// ASSUMPTION: 7 days bounds level-demotion lag (attestation expiry/revocation) while
    /// keeping refresh cost low. Overturned if Grayr's revocation SLA requires faster.
    uint64 public constant LEAF_TTL = 7 days;
    uint8 public constant MIN_LEVEL = 1;

    MerkleTree.Tree internal _tree;
    mapping(bytes32 vendorId => uint64) public categoriesOf;

    event VendorPublished(
        bytes32 indexed vendorId,
        address indexed wallet,
        uint256 leaf,
        uint256 leafIndex,
        uint8 level,
        uint64 categories,
        uint64 expiry,
        uint256 root
    );
    event CategoriesSet(bytes32 indexed vendorId, uint64 categories, address indexed verifier);

    error VendorNotActive(bytes32 vendorId);
    error WalletNotOfVendor(address wallet, bytes32 vendorId);
    error LevelTooLow(uint8 level);
    error NotVerifier(address caller);

    constructor(IVendorRegistry registry_, IAttestationLevels attestations_, IPoseidon2 poseidon2_, address admin) {
        registry = registry_;
        attestations = attestations_;
        poseidon2 = poseidon2_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _tree.init();
    }

    /// @notice Attest a vendor's category bitmask (bit i = category i; see zk/docs/policy.md).
    function setCategories(bytes32 vendorId, uint64 categories) external {
        if (!attestations.hasRole(attestations.VERIFIER_ROLE(), msg.sender)) revert NotVerifier(msg.sender);
        categoriesOf[vendorId] = categories;
        emit CategoriesSet(vendorId, categories, msg.sender);
    }

    /// @notice Snapshot (vendor, wallet) into a fresh leaf. Anyone may call (merchants,
    ///         relayers, Grayr's keeper); re-publish before expiry to stay payable.
    function publish(bytes32 vendorId, address wallet) external returns (uint256 leaf, uint256 leafIndex) {
        if (registry.vendorStatus(vendorId) != IVendorRegistry.VendorStatus.Active) {
            revert VendorNotActive(vendorId);
        }
        if (registry.vendorIdForWallet(wallet) != vendorId) revert WalletNotOfVendor(wallet, vendorId);
        uint8 level = attestations.verificationLevel(vendorId);
        if (level < MIN_LEVEL) revert LevelTooLow(level);

        uint64 cats = categoriesOf[vendorId];
        uint64 expiry = uint64(block.timestamp) + LEAF_TTL;
        leaf = ShieldedHashes.vendorLeaf(poseidon2, wallet, level, cats, expiry);
        uint256[] memory leaves = new uint256[](1);
        leaves[0] = leaf;
        leafIndex = _tree.insert(poseidon2, leaves);
        emit VendorPublished(vendorId, wallet, leaf, leafIndex, level, cats, expiry, _tree.root);
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return _tree.isKnownRoot(root);
    }

    function isActiveVendorWallet(address wallet) external view returns (bool) {
        bytes32 id = registry.vendorIdForWallet(wallet);
        return id != bytes32(0) && registry.vendorStatus(id) == IVendorRegistry.VendorStatus.Active;
    }

    function root() external view returns (uint256) {
        return _tree.root;
    }

    function nextIndex() external view returns (uint256) {
        return _tree.nextIndex;
    }
}
