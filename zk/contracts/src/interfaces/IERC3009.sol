// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Subset of Circle FiatToken V2.2 (USDC) used by Path B. Signatures verified against
/// circlefin/stablecoin-evm (EIP3009.sol, FiatTokenV2_2.sol) and the bytecode deployed on
/// Base (0x8335…2913) and Base Sepolia (0x036C…CF7e): see zk/docs/path-b.md.
interface IERC3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}
