// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "../src/VendorRegistry.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IVendorRegistry} from "../src/interfaces/IVendorRegistry.sol";

/// Randomized-actor handler. All calls are best-effort (unguarded reverts are fine because
/// fail_on_revert = false); the handler records ghost state for the invariants.
contract RegistryHandler is Test {
    VendorRegistry public immutable registry;
    AttestationRegistry public immutable attestations;
    address public immutable guardian;
    address public immutable verifier;

    address[] public actors;
    bytes32[] public registered;
    // ghost state
    mapping(bytes32 => bool) public everRevoked;
    mapping(bytes32 => uint64) public lastMetadataVersion;
    uint256 public registerCalls;

    constructor(VendorRegistry _r, AttestationRegistry _a, address _guardian, address _verifier) {
        registry = _r;
        attestations = _a;
        guardian = _guardian;
        verifier = _verifier;
        for (uint256 i = 0; i < 5; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _vendor(uint256 seed) internal view returns (bytes32) {
        if (registered.length == 0) return bytes32(0);
        return registered[seed % registered.length];
    }

    function register(uint256 actorSeed, uint256 domainSeed) external {
        registerCalls++;
        string memory domain = string.concat("v", vm.toString(domainSeed % 40), ".example");
        string[] memory extra = new string[](0);
        address[] memory wallets = new address[](1);
        wallets[0] = address(uint160(uint256(keccak256(abi.encode("w", domainSeed % 40)))));

        vm.prank(_actor(actorSeed));
        try registry.registerVendor(domain, extra, wallets, "", keccak256(abi.encode(domainSeed)), "uri") returns (
            bytes32 id
        ) {
            registered.push(id);
            lastMetadataVersion[id] = 1;
        } catch {}
    }

    function setMetadata(uint256 actorSeed, uint256 vendorSeed, bytes32 h) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        vm.prank(_actor(actorSeed));
        try registry.setMetadata(id, h == bytes32(0) ? bytes32(uint256(1)) : h, "uri") {
            lastMetadataVersion[id]++;
        } catch {}
    }

    function transferAndAccept(uint256 fromSeed, uint256 toSeed, uint256 vendorSeed) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        address to = _actor(toSeed);
        vm.prank(_actor(fromSeed));
        try registry.transferVendorOwnership(id, to) {} catch {}
        vm.prank(to);
        try registry.acceptVendorOwnership(id) {} catch {}
    }

    function suspend(uint256 vendorSeed) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        vm.prank(guardian);
        try registry.suspendVendor(id, "inv") {} catch {}
    }

    function unsuspend(uint256 vendorSeed) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        vm.prank(guardian);
        try registry.unsuspendVendor(id, "inv") {} catch {}
    }

    function revoke(uint256 vendorSeed) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        vm.prank(guardian);
        try registry.revokeVendor(id, "inv") {
            everRevoked[id] = true;
        } catch {}
    }

    function attest(uint256 vendorSeed, uint8 attType, uint32 validity) external {
        bytes32 id = _vendor(vendorSeed);
        if (id == bytes32(0)) return;
        uint64 expiry = uint64(block.timestamp + 1 + (validity % 730 days));
        vm.prank(verifier);
        try attestations.attest(id, 1 + (attType % 5), keccak256(abi.encode(attType)), expiry) {} catch {}
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + (secs % 90 days));
    }

    function registeredCount() external view returns (uint256) {
        return registered.length;
    }

    function registeredAt(uint256 i) external view returns (bytes32) {
        return registered[i];
    }
}

contract InvariantTest is Test {
    VendorRegistry internal registry;
    AttestationRegistry internal attestations;
    RegistryHandler internal handler;
    address internal admin = makeAddr("admin");

    function setUp() public {
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

        address guardian = makeAddr("guardian");
        address verifier = makeAddr("verifier");
        vm.startPrank(admin);
        registry.grantRole(registry.GUARDIAN_ROLE(), guardian);
        attestations.grantRole(attestations.VERIFIER_ROLE(), verifier);
        vm.stopPrank();

        handler = new RegistryHandler(registry, attestations, guardian, verifier);
        targetContract(address(handler));
        vm.warp(1_752_000_000);
    }

    /// Every registered vendor's primary domain resolves back to exactly that vendor id,
    /// and its vendorId is the deterministic hash of that domain — regardless of status.
    function invariant_primaryDomainBijection() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            IVendorRegistry.VendorView memory v = registry.getVendor(id);
            assertEq(registry.vendorIdForDomain(v.primaryDomain), id);
        }
    }

    /// Revocation is terminal: once the handler observed a successful revoke, the vendor can
    /// never leave Revoked status.
    function invariant_revocationTerminal() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            if (handler.everRevoked(id)) {
                assertEq(uint8(registry.vendorStatus(id)), uint8(IVendorRegistry.VendorStatus.Revoked));
            }
        }
    }

    /// Registered vendors always hold a valid lifecycle status (never None) and every wallet
    /// they list maps back to them.
    function invariant_statusValid_andWalletClaimsConsistent() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            IVendorRegistry.VendorView memory v = registry.getVendor(id);
            assertTrue(v.status != IVendorRegistry.VendorStatus.None);
            for (uint256 j = 0; j < v.wallets.length; j++) {
                assertEq(registry.vendorIdForWallet(v.wallets[j]), id);
            }
        }
    }

    /// Onchain metadata version always equals the handler's ghost count of successful writes
    /// (i.e. versions are strictly monotonic, bumped exactly once per anchor).
    function invariant_metadataVersionMonotonic() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            assertEq(registry.getVendor(id).metadataVersion, handler.lastMetadataVersion(id));
        }
    }

    /// Vendor count never decreases and matches the number of successful registrations.
    function invariant_vendorCountMatches() public view {
        assertEq(registry.vendorCount(), handler.registeredCount());
    }

    /// A non-Active vendor never reports a nonzero verification level.
    function invariant_inactiveVendorsHaveLevelZero() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            if (registry.vendorStatus(id) != IVendorRegistry.VendorStatus.Active) {
                assertEq(attestations.verificationLevel(id), 0);
            }
        }
    }

    /// Verification level is always within the defined 0..5 range, for every vendor.
    function invariant_verificationLevelInRange() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            assertLe(attestations.verificationLevel(handler.registeredAt(i)), 5);
        }
    }

    /// Every registered vendor has a non-zero owner and a canonical id matching its domain.
    function invariant_ownerAndIdWellFormed() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            IVendorRegistry.VendorView memory v = registry.getVendor(id);
            assertTrue(v.owner != address(0));
            assertEq(v.vendorId, id);
            assertEq(registry.computeVendorId(v.primaryDomain), id);
        }
    }

    /// Every wallet a vendor lists resolves back to that same vendor (claim-map consistency).
    function invariant_walletClaimsConsistent() public view {
        uint256 n = handler.registeredCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.registeredAt(i);
            IVendorRegistry.VendorView memory v = registry.getVendor(id);
            for (uint256 j = 0; j < v.wallets.length; j++) {
                assertEq(registry.vendorIdForWallet(v.wallets[j]), id);
            }
        }
    }
}
