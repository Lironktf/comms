// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IAssociationSet {
    function isValidRoot(uint256 root) external view returns (bool);
}
