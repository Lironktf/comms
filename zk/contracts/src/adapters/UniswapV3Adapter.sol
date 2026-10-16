// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IV3SwapRouter} from "./IV3SwapRouter.sol";

/// @title UniswapV3Adapter — private swaps through Uniswap V3 (SwapRouter02).
/// @notice Called only by the pool, which has already transferred `amountIn` here. Swaps
///         single-hop and sends the output straight back to the pool. Holds no funds between
///         calls. `data` = abi.encode(uint24 poolFee). Slippage (minAmountOut) is bound in the
///         user's proof and checked again by the pool on what it actually received.
contract UniswapV3Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IV3SwapRouter public immutable router;
    address public immutable pool;

    error OnlyPool();

    constructor(IV3SwapRouter router_, address pool_) {
        router = router_;
        pool = pool_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata data, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != pool) revert OnlyPool();
        uint24 fee = abi.decode(data, (uint24));
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(router), 0);
    }
}
