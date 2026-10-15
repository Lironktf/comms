// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPoseidon2} from "../interfaces/IPoseidon2.sol";

/// @title ShieldedHashes — the on-chain subset of the protocol hashes.
/// @notice Mirror of zk/circuits/lib/src/lib.nr. Only the hashes the contracts must compute
///         themselves live here: Merkle nodes, note commitments built at deposit / swap /
///         refund time, and verified-vendor leaves. Every hash is a single Poseidon2
///         permutation (arity 2 or 3), computed by ONE shared Poseidon2 contract.
library ShieldedHashes {
    /// BN254 scalar field modulus. Every public input to a proof must be < FIELD.
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 internal constant TAG_NOTE = 3;
    uint256 internal constant TAG_VENDOR = 8;

    /// Raw staticcall to the shared Poseidon2 contract (poseidon2-evm's fallback dispatches on
    /// calldata length: 4-byte selector + n words => hash_n). Skips Solidity's extcodesize
    /// check and ABI decoding; the pool and VendorTree only ever pass the immutable address
    /// of the contract deployed by their deploy script.
    function h2(IPoseidon2 p, uint256 a, uint256 b) internal view returns (uint256 r) {
        bytes4 sel = IPoseidon2.hash_2.selector;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            mstore(add(m, 0x04), a)
            mstore(add(m, 0x24), b)
            if iszero(staticcall(gas(), p, m, 0x44, 0x00, 0x20)) { revert(0, 0) }
            if iszero(eq(returndatasize(), 0x20)) { revert(0, 0) }
            r := mload(0x00)
        }
    }

    function h3(IPoseidon2 p, uint256 a, uint256 b, uint256 c) internal view returns (uint256 r) {
        bytes4 sel = IPoseidon2.hash_3.selector;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            mstore(add(m, 0x04), a)
            mstore(add(m, 0x24), b)
            mstore(add(m, 0x44), c)
            if iszero(staticcall(gas(), p, m, 0x64, 0x00, 0x20)) { revert(0, 0) }
            if iszero(eq(returndatasize(), 0x20)) { revert(0, 0) }
            r := mload(0x00)
        }
    }

    /// core = H3(NOTE, label, inner)
    function noteCore(IPoseidon2 p, uint256 label, uint256 inner) internal view returns (uint256) {
        return h3(p, TAG_NOTE, label, inner);
    }

    /// commitment = H3(amount, token, core)
    function commitment(IPoseidon2 p, uint256 amount, address token, uint256 core) internal view returns (uint256) {
        return h3(p, amount, uint256(uint160(token)), core);
    }

    /// leaf = H3(VENDOR, wallet, H3(level, categories, expiry))
    function vendorLeaf(IPoseidon2 p, address wallet, uint256 level, uint256 categories, uint256 expiry)
        internal
        view
        returns (uint256)
    {
        return h3(p, TAG_VENDOR, uint256(uint160(wallet)), h3(p, level, categories, expiry));
    }

    /// Hash arbitrary context data into the field (keccak, reduced mod FIELD). The circuits
    /// treat it as an opaque public input; the contract recomputes it from calldata, so any
    /// change to the bound data makes the proof fail.
    function toField(bytes32 x) internal pure returns (uint256) {
        return uint256(x) % FIELD;
    }
}
