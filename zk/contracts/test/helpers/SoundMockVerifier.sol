// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IHonkVerifier} from "../../src/interfaces/IHonkVerifier.sol";

/// Stands in for a SOUND verifier in pool-logic tests: it accepts exactly the public-input
/// vectors a test (or invariant handler) has declared true, i.e. statements that a real proof
/// could exist for. This isolates the contract's accounting/ordering logic from proving.
/// The real generated verifiers are tested against real proofs in Verifiers.t.sol.
contract SoundMockVerifier is IHonkVerifier {
    mapping(bytes32 => bool) public isTrue;

    function declareTrue(bytes32[] calldata pub) external {
        isTrue[keccak256(abi.encode(pub))] = true;
    }

    function verify(bytes calldata, bytes32[] calldata pub) external view returns (bool) {
        return isTrue[keccak256(abi.encode(pub))];
    }
}
