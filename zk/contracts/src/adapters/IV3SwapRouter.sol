// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Uniswap V3 SwapRouter02 single-hop exact-input interface (IV3SwapRouter in
/// Uniswap/swap-router-contracts: SwapRouter02 has NO deadline field in this struct).
/// SwapRouter02 on Base: 0x2626664c2603336E57B271c5C0b26F421741e481 (Uniswap docs).
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
