// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoseidon2} from "../src/interfaces/IPoseidon2.sol";
import {ShieldedHashes} from "../src/libraries/ShieldedHashes.sol";
import {MerkleTree} from "../src/libraries/MerkleTree.sol";

contract TreeHarness {
    using MerkleTree for MerkleTree.Tree;

    MerkleTree.Tree t;
    IPoseidon2 public p;

    constructor(IPoseidon2 p_) {
        p = p_;
        t.init();
    }

    function insert(uint256[] memory leaves) external returns (uint256) {
        return t.insert(p, leaves);
    }

    function root() external view returns (uint256) {
        return t.root;
    }

    function known(uint256 r) external view returns (bool) {
        return t.isKnownRoot(r);
    }
}

/// Naive reference: recompute the whole root from all leaves (sparse, depth 20).
contract ReferenceTree {
    IPoseidon2 p;
    uint256[] leaves;

    constructor(IPoseidon2 p_) {
        p = p_;
    }

    function push(uint256 l) external {
        leaves.push(l);
    }

    function root() external view returns (uint256) {
        uint256 n = leaves.length;
        uint256[] memory level = new uint256[](n == 0 ? 1 : n);
        for (uint256 i; i < n; ++i) level[i] = leaves[i];
        uint256 len = n;
        for (uint256 d; d < 20; ++d) {
            uint256 pl = (len + 1) / 2;
            if (len == 0) pl = 0;
            for (uint256 k; k < pl; ++k) {
                uint256 l = level[2 * k];
                uint256 r = 2 * k + 1 < len ? level[2 * k + 1] : MerkleTree.zeros(d);
                level[k] = ShieldedHashes.h2(p, l, r);
            }
            len = pl;
        }
        return n == 0 ? MerkleTree.zeros(20) : level[0];
    }
}

contract MerkleTreeTest is Test {
    TreeHarness h;
    ReferenceTree ref;

    function setUp() public {
        IPoseidon2 p = IPoseidon2(deployCode("Poseidon2Yul.sol:Poseidon2Yul_BN254"));
        h = new TreeHarness(p);
        ref = new ReferenceTree(p);
    }

    function test_emptyRoot() public view {
        assertEq(h.root(), MerkleTree.zeros(20));
        assertTrue(h.known(MerkleTree.zeros(20)));
    }

    /// Differential fuzz: arbitrary sequences of batch sizes (aligned and unaligned)
    /// must give exactly the same root as the naive full recomputation.
    function testFuzz_batchInsertMatchesReference(uint8[6] memory sizes, uint256 seed) public {
        for (uint256 b; b < sizes.length; ++b) {
            uint256 n = uint256(sizes[b]) % 7 + 1;
            uint256[] memory leaves = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                leaves[i] = uint256(keccak256(abi.encode(seed, b, i))) % ShieldedHashes.FIELD;
                ref.push(leaves[i]);
            }
            h.insert(leaves);
            assertEq(h.root(), ref.root(), "root mismatch");
        }
    }

    function test_rootHistoryWindow() public {
        uint256 first;
        for (uint256 i; i < MerkleTree.ROOT_HISTORY + 1; ++i) {
            uint256[] memory leaves = new uint256[](1);
            leaves[0] = i + 1;
            h.insert(leaves);
            if (i == 0) first = h.root();
        }
        // `first` was root #2; after ROOT_HISTORY more roots it falls out of the window.
        assertFalse(h.known(first));
        assertTrue(h.known(h.root()));
        assertFalse(h.known(12345));
    }

    function test_gas_pairInsert() public {
        uint256[] memory two = new uint256[](2);
        two[0] = 1;
        two[1] = 2;
        h.insert(two); // warm up storage slots
        two[0] = 3;
        two[1] = 4;
        uint256 g = gasleft();
        h.insert(two);
        emit log_named_uint("gas: insert 2 leaves (aligned pair)", g - gasleft());
        uint256[] memory eight = new uint256[](8);
        for (uint256 i; i < 8; ++i) eight[i] = 10 + i;
        g = gasleft();
        h.insert(eight);
        emit log_named_uint("gas: insert 8 leaves (batch of 4 spends)", g - gasleft());
    }
}
