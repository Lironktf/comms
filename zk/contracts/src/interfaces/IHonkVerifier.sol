// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Interface of the bb-generated UltraHonk Solidity verifiers (src/verifiers/*).
/// `publicInputs` are the circuit's `pub` parameters in declaration order, one field
/// element per bytes32 (arrays flattened). Reverts on malformed proofs, returns false
/// or reverts on invalid ones; callers must treat both as rejection.
interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
