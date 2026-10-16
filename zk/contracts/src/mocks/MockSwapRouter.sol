// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IV3SwapRouter} from "../adapters/IV3SwapRouter.sol";

/// LOCAL TESTING ONLY: SwapRouter02-shaped router with a fixed price per pair
/// (amountOut = amountIn * num / den), paid from its own token balance.
contract MockSwapRouter is IV3SwapRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256[2])) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        rate[tokenIn][tokenOut] = [num, den];
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        uint256[2] memory r = rate[p.tokenIn][p.tokenOut];
        require(r[1] != 0, "no pair");
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn * r[0] / r[1];
        require(amountOut >= p.amountOutMinimum, "Too little received");
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }
}
