// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAssociationSet} from "./interfaces/IAssociationSet.sol";

/// @title AssociationSetRegistry — the Privacy Pools "association set provider" (ASP).
/// @notice An ASP curates the set of deposit labels it considers clean (e.g. not from a
///         sanctioned address), builds a Poseidon2 Merkle tree of them offchain, and posts the
///         root here together with a content address (IPFS CID) of the full label list so
///         anyone can recompute and audit it. Private spends must prove their deposit label is
///         in the CURRENT set. Excluded deposits can still exit via ragequit (public, back to
///         the original depositor).
///
///         Only the latest root is valid, plus the previous root for GRACE seconds after it
///         was replaced (so proofs in flight survive a routine update). This bounds how long a
///         freshly excluded deposit can still move privately to GRACE.
contract AssociationSetRegistry is AccessControl, IAssociationSet {
    bytes32 public constant POSTMAN_ROLE = keccak256("POSTMAN_ROLE");
    /// ASSUMPTION: 10 minutes covers proof generation (seconds) + relayer inclusion.
    /// Overturned if relayer logs show spends failing on ASP root rotation.
    uint64 public constant GRACE = 10 minutes;

    uint256 public latestRoot;
    uint256 public previousRoot;
    uint64 public latestAt;
    uint256 public version;

    event RootPublished(uint256 indexed version, uint256 indexed root, string cid, uint64 timestamp);

    error ZeroRoot();
    error SameRoot();
    error NotField(uint256 root);

    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    constructor(address admin, address postman) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POSTMAN_ROLE, postman);
    }

    function publishRoot(uint256 root, string calldata cid) external onlyRole(POSTMAN_ROLE) {
        if (root == 0) revert ZeroRoot();
        if (root == latestRoot) revert SameRoot();
        if (root >= FIELD) revert NotField(root);
        previousRoot = latestRoot;
        latestRoot = root;
        latestAt = uint64(block.timestamp);
        emit RootPublished(++version, root, cid, uint64(block.timestamp));
    }

    function isValidRoot(uint256 root) external view returns (bool) {
        if (root == 0) return false;
        if (root == latestRoot) return true;
        return root == previousRoot && block.timestamp < uint256(latestAt) + GRACE;
    }
}
