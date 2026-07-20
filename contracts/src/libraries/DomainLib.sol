// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title DomainLib — validation and hashing for DNS domain names used as vendor identifiers.
/// @dev Only lowercase ASCII LDH (letters-digits-hyphen) domains are accepted. Rejecting
///      uppercase (rather than normalizing) keeps hashing deterministic across clients, and
///      rejecting non-ASCII forces IDNs through punycode (`xn--`), which blocks trivial
///      unicode-homograph impersonation at the contract layer.
library DomainLib {
    uint256 internal constant MIN_LENGTH = 4; // shortest real registrable domain, e.g. "a.co"
    uint256 internal constant MAX_LENGTH = 253; // RFC 1035
    uint256 internal constant MAX_LABEL_LENGTH = 63; // RFC 1035

    /// @notice Returns true iff `domain` is a syntactically valid, normalized (lowercase ASCII)
    ///         absolute domain name with at least two labels.
    function isValid(string memory domain) internal pure returns (bool) {
        bytes memory b = bytes(domain);
        uint256 len = b.length;
        if (len < MIN_LENGTH || len > MAX_LENGTH) return false;

        uint256 labelLen = 0;
        uint256 labelCount = 0;
        bytes1 prev = ".";

        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            if (c == ".") {
                // no empty labels, no label ending in '-'
                if (labelLen == 0 || prev == "-") return false;
                labelCount++;
                labelLen = 0;
            } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
                labelLen++;
                if (labelLen > MAX_LABEL_LENGTH) return false;
            } else if (c == "-") {
                // label cannot start with '-'
                if (labelLen == 0) return false;
                labelLen++;
                if (labelLen > MAX_LABEL_LENGTH) return false;
            } else {
                return false; // uppercase, unicode, or other character
            }
            prev = c;
        }
        // final label must be non-empty and not end with '-'
        if (labelLen == 0 || prev == "-") return false;
        labelCount++;

        return labelCount >= 2;
    }

    /// @notice Canonical hash of a normalized domain.
    function hash(string memory domain) internal pure returns (bytes32) {
        return keccak256(bytes(domain));
    }
}
