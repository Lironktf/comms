// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "@grayr/VendorRegistry.sol";
import {AttestationRegistry} from "@grayr/AttestationRegistry.sol";
import {IVendorRegistry} from "@grayr/interfaces/IVendorRegistry.sol";
import {ShieldedPool} from "../../src/ShieldedPool.sol";
import {VendorTree} from "../../src/VendorTree.sol";
import {AssociationSetRegistry} from "../../src/AssociationSetRegistry.sol";
import {IHonkVerifier} from "../../src/interfaces/IHonkVerifier.sol";
import {IAssociationSet} from "../../src/interfaces/IAssociationSet.sol";
import {IVendorTree} from "../../src/interfaces/IVendorTree.sol";
import {IAttestationLevels} from "../../src/interfaces/IAttestationLevels.sol";
import {IPoseidon2} from "../../src/interfaces/IPoseidon2.sol";
import {ShieldedHashes} from "../../src/libraries/ShieldedHashes.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {SoundMockVerifier} from "./SoundMockVerifier.sol";

/// Full pool stack with SoundMockVerifiers, real Grayr registries, real Poseidon2.
abstract contract PoolFixture is Test {
    uint256 internal constant FIELD = ShieldedHashes.FIELD;

    IPoseidon2 internal p2;
    SoundMockVerifier internal vTransact;
    SoundMockVerifier internal vPolicy;
    SoundMockVerifier internal vBudget;
    SoundMockVerifier internal vRagequit;
    VendorRegistry internal vendors;
    AttestationRegistry internal attestations;
    VendorTree internal vendorTree;
    AssociationSetRegistry internal asp;
    ShieldedPool internal pool;
    MockUSDC internal usdc;

    address internal admin = address(this);
    address internal relayer = makeAddr("relayer");
    address internal merchant = makeAddr("merchant");

    function setUpPool() internal {
        p2 = IPoseidon2(deployCode("Poseidon2Yul.sol:Poseidon2Yul_BN254"));
        vTransact = new SoundMockVerifier();
        vPolicy = new SoundMockVerifier();
        vBudget = new SoundMockVerifier();
        vRagequit = new SoundMockVerifier();
        vendors = VendorRegistry(
            address(new ERC1967Proxy(address(new VendorRegistry()), abi.encodeCall(VendorRegistry.initialize, (admin))))
        );
        attestations = AttestationRegistry(
            address(
                new ERC1967Proxy(
                    address(new AttestationRegistry()),
                    abi.encodeCall(AttestationRegistry.initialize, (admin, IVendorRegistry(address(vendors))))
                )
            )
        );
        attestations.grantRole(attestations.VERIFIER_ROLE(), admin);
        vendorTree = new VendorTree(IVendorRegistry(address(vendors)), IAttestationLevels(address(attestations)), p2, admin);
        asp = new AssociationSetRegistry(admin, admin);
        pool = new ShieldedPool(
            IHonkVerifier(address(vTransact)),
            IHonkVerifier(address(vPolicy)),
            IHonkVerifier(address(vBudget)),
            IHonkVerifier(address(vRagequit)),
            IAssociationSet(address(asp)),
            IVendorTree(address(vendorTree)),
            p2,
            admin
        );
        usdc = new MockUSDC();
        pool.configureToken(address(usdc), true, true, 1_000_000e6);
        asp.publishRoot(777, "test");
    }

    function ext(address feeRecipient, bytes32 requestId) internal view returns (ShieldedPool.ExtData memory e) {
        e.feeRecipient = feeRecipient;
        e.requestId = requestId;
        e.deadline = uint64(block.timestamp + 600);
        e.encryptedOutput0 = hex"01";
        e.encryptedOutput1 = hex"02";
    }

    function transactPub(ShieldedPool.TransactInputs memory t, bool deferred, uint256 context)
        internal
        pure
        returns (bytes32[] memory pub)
    {
        pub = new bytes32[](12);
        pub[0] = bytes32(t.root);
        pub[1] = bytes32(t.aspRoot);
        pub[2] = bytes32(t.nullifiers[0]);
        pub[3] = bytes32(t.nullifiers[1]);
        pub[4] = bytes32(t.outCommitments[0]);
        pub[5] = bytes32(t.outCommitments[1]);
        pub[6] = bytes32(t.publicAmount);
        pub[7] = bytes32(t.fee);
        pub[8] = bytes32(uint256(uint160(t.token)));
        pub[9] = bytes32(uint256(uint160(t.recipient)));
        pub[10] = bytes32(deferred ? uint256(1) : 0);
        pub[11] = bytes32(context);
    }

    function deposit(address who, uint256 amount, uint256 inner) internal returns (uint256 label, uint256 cm, uint256 leaf) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        (label, cm, leaf) = pool.deposit(address(usdc), amount, inner, "");
        vm.stopPrank();
    }
}
