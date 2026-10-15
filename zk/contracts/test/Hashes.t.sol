// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoseidon2} from "../src/interfaces/IPoseidon2.sol";
import {ShieldedHashes} from "../src/libraries/ShieldedHashes.sol";
import {MerkleTree} from "../src/libraries/MerkleTree.sol";

/// Solidity hashes == Noir circuit hashes == TypeScript client hashes, via the shared
/// vectors printed by the Noir test `print_vectors` (zk/test-vectors/vectors.json).
contract HashesTest is Test {
    IPoseidon2 p;
    string json;

    function setUp() public {
        p = IPoseidon2(deployCode("Poseidon2Yul.sol:Poseidon2Yul_BN254"));
        json = vm.readFile("../test-vectors/vectors.json");
    }

    function _v(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function test_h2_h3_matchNoir() public view {
        assertEq(ShieldedHashes.h2(p, 1, 2), _v(".h2_1_2"));
        assertEq(ShieldedHashes.h3(p, 1, 2, 3), _v(".h3_1_2_3"));
    }

    function test_commitmentMatchesNoir() public view {
        uint256 inner = _v(".inner");
        uint256 core = ShieldedHashes.noteCore(p, 77, inner);
        assertEq(ShieldedHashes.commitment(p, 5000000, address(uint160(0xa0b86991)), core), _v(".commitment"));
    }

    function test_vendorLeafMatchesNoir() public view {
        assertEq(
            ShieldedHashes.vendorLeaf(p, address(0xbeef), 3, 5, 1800000000), _v(".vendor_leaf.value")
        );
    }

    function test_emptyRootMatchesNoir() public view {
        assertEq(MerkleTree.zeros(20), _v(".empty_root_20"));
        for (uint256 i; i < 20; ++i) {
            assertEq(MerkleTree.zeros(i + 1), ShieldedHashes.h2(p, MerkleTree.zeros(i), MerkleTree.zeros(i)));
        }
    }

    function test_gas_h2() public {
        uint256 g = gasleft();
        ShieldedHashes.h2(p, 1, 2);
        emit log_named_uint("gas per external Poseidon2 hash_2 (warm)", g - gasleft());
    }
}
