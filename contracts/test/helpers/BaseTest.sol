// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "../../src/VendorRegistry.sol";
import {AttestationRegistry} from "../../src/AttestationRegistry.sol";
import {IVendorRegistry} from "../../src/interfaces/IVendorRegistry.sol";

abstract contract BaseTest is Test {
    VendorRegistry internal registry;
    AttestationRegistry internal attestations;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal vendorOwner = makeAddr("vendorOwner");
    address internal otherOwner = makeAddr("otherOwner");
    address internal rando = makeAddr("rando");

    // Verifier with a known private key so we can produce EIP-712 signatures.
    uint256 internal verifierPk = 0xA11CE;
    address internal verifier;

    string internal constant DOMAIN = "acme.example";
    bytes32 internal constant META_HASH = keccak256("metadata-v1");
    string internal constant META_URI = "https://registry.actp.dev/vendors/acme.example/metadata/1";

    function setUp() public virtual {
        verifier = vm.addr(verifierPk);

        VendorRegistry regImpl = new VendorRegistry();
        registry = VendorRegistry(
            address(new ERC1967Proxy(address(regImpl), abi.encodeCall(VendorRegistry.initialize, (admin))))
        );

        AttestationRegistry attImpl = new AttestationRegistry();
        attestations = AttestationRegistry(
            address(
                new ERC1967Proxy(
                    address(attImpl),
                    abi.encodeCall(
                        AttestationRegistry.initialize, (admin, IVendorRegistry(address(registry)))
                    )
                )
            )
        );

        vm.startPrank(admin);
        registry.grantRole(registry.GUARDIAN_ROLE(), guardian);
        attestations.grantRole(attestations.VERIFIER_ROLE(), verifier);
        vm.stopPrank();

        // Deterministic, non-zero starting time so expiry math is sane.
        vm.warp(1_752_000_000);
    }

    function _registerVendor(address owner_, string memory domain) internal returns (bytes32 vendorId) {
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](1);
        wallets[0] = makeAddr(string.concat("wallet:", domain));
        vm.prank(owner_);
        vendorId = registry.registerVendor(domain, extra, wallets, "", META_HASH, META_URI);
    }

    function _signAttestation(uint256 pk, AttestationRegistry.AttestationRequest memory req)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = attestations.hashAttestationRequest(req);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
