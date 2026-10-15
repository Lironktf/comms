// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IHonkVerifier} from "../src/interfaces/IHonkVerifier.sol";
import {VerifierLinker} from "../script/VerifierLinker.sol";

/// The generated Solidity verifiers against REAL proofs (zk/client/scripts/gen-fixtures.ts).
/// For every circuit: the honest proof verifies; changing ANY single public input, or any
/// part of the proof, is rejected. This is what makes "bound as a public input" true onchain,
/// including inputs no circuit constraint uses (recipient, context).
contract VerifiersTest is Test {
    struct Fixture {
        bytes proof;
        bytes32[] publicInputs;
    }

    function _load(string memory c) internal view returns (Fixture memory f) {
        string memory j = vm.readFile(string.concat("test/fixtures/", c, ".json"));
        f.proof = vm.parseJsonBytes(j, ".proof");
        f.publicInputs = vm.parseJsonBytes32Array(j, ".publicInputs");
    }

    function _accepts(IHonkVerifier v, bytes memory proof, bytes32[] memory pub) internal view returns (bool) {
        try v.verify(proof, pub) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _check(string memory verifierName, string memory circuit) internal {
        IHonkVerifier v = IHonkVerifier(VerifierLinker.deploy(verifierName));
        Fixture memory f = _load(circuit);

        uint256 g = gasleft();
        bool ok = v.verify(f.proof, f.publicInputs);
        uint256 used = g - gasleft();
        assertTrue(ok, "honest proof must verify");
        emit log_named_uint(string.concat(circuit, " verify gas"), used);

        for (uint256 i; i < f.publicInputs.length; ++i) {
            bytes32[] memory pub = new bytes32[](f.publicInputs.length);
            for (uint256 k; k < pub.length; ++k) pub[k] = f.publicInputs[k];
            pub[i] = bytes32(uint256(pub[i]) ^ 1);
            assertFalse(_accepts(v, f.proof, pub), string.concat("tampered public input accepted: #", vm.toString(i)));
        }
        // flip one byte at several places in the proof
        for (uint256 off = 31; off < f.proof.length; off += 997) {
            bytes memory p = bytes.concat(f.proof);
            p[off] = bytes1(uint8(p[off]) ^ 0x01);
            assertFalse(_accepts(v, p, f.publicInputs), "tampered proof accepted");
        }
        // wrong number of public inputs
        bytes32[] memory shorter = new bytes32[](f.publicInputs.length - 1);
        for (uint256 k; k < shorter.length; ++k) shorter[k] = f.publicInputs[k];
        assertFalse(_accepts(v, f.proof, shorter), "short public inputs accepted");
        // a proof for one circuit never verifies on another circuit's verifier (checked below)
    }

    function test_transact() public {
        _check("TransactVerifier", "transact");
    }

    function test_policyPay() public {
        _check("PolicyPayVerifier", "policy_pay");
    }

    function test_budgetInit() public {
        _check("BudgetInitVerifier", "budget_init");
    }

    function test_ragequit() public {
        _check("RagequitVerifier", "ragequit");
    }

    function test_m0() public {
        _check("M0CommitmentVerifier", "m0_commitment");
        _check("M0MerkleVerifier", "m0_merkle");
    }

    function test_crossCircuitProofRejected() public {
        IHonkVerifier v = IHonkVerifier(VerifierLinker.deploy("PolicyPayVerifier"));
        Fixture memory f = _load("transact");
        assertFalse(_accepts(v, f.proof, f.publicInputs));
    }
}
