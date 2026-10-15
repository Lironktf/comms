// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// The two read functions VendorTree needs from Grayr's AttestationRegistry.
interface IAttestationLevels {
    function verificationLevel(bytes32 vendorId) external view returns (uint8);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function VERIFIER_ROLE() external view returns (bytes32);
}
