// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// A swap adapter receives `amountIn` of `tokenIn` (already transferred to it by the pool),
/// swaps on an external venue, and transfers the output to `recipient` (the pool).
/// The pool measures what it actually received; the adapter's return value is advisory.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata data, address recipient)
        external
        returns (uint256 amountOut);
}
