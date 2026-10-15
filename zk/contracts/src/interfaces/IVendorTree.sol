// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IVendorTree {
    function isKnownRoot(uint256 root) external view returns (bool);
    /// Live check against the Grayr VendorRegistry: the wallet belongs to an Active vendor.
    function isActiveVendorWallet(address wallet) external view returns (bool);
}
