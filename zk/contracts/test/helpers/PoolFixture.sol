// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "@grayr/VendorRegistry.sol";
import {AttestationRegistry} from "@grayr/AttestationRegistry.sol";
import {IVendorRegistry} from "@grayr/interfaces/IVendorRegistry.sol";
import {ShieldedPool} from "../../src/ShieldedPool.sol";
import {ShieldedPoolCore} from "../../src/ShieldedPoolCore.sol";
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
    /// aggregate roots for 2, 4, 8 payments (docs/aggregation.md)
    SoundMockVerifier[3] internal vAgg;
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
        for (uint256 i; i < 3; ++i) vAgg[i] = new SoundMockVerifier();
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
            admin,
            [IHonkVerifier(address(vAgg[0])), IHonkVerifier(address(vAgg[1])), IHonkVerifier(address(vAgg[2]))]
        );
        usdc = new MockUSDC();
        pool.configureToken(address(usdc), true, true, 1_000_000e6);
        asp.publishRoot(777, "test");
    }

    function ext(address feeRecipient, bytes32 requestId) internal view returns (ShieldedPoolCore.ExtData memory e) {
        e.feeRecipient = feeRecipient;
        e.requestId = requestId;
        e.deadline = uint64(block.timestamp + 600);
        e.encryptedOutput0 = hex"01";
        e.encryptedOutput1 = hex"02";
    }

    function transactPub(ShieldedPoolCore.TransactInputs memory t, bool deferred, uint256 context)
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

    function policyPub(ShieldedPoolCore.PolicyInputs memory p, uint256 context) internal pure returns (bytes32[] memory pub) {
        pub = new bytes32[](16);
        pub[0] = bytes32(p.root);
        pub[1] = bytes32(p.aspRoot);
        pub[2] = bytes32(p.vendorRoot);
        pub[3] = bytes32(p.vendorChecked ? uint256(1) : 0);
        pub[4] = bytes32(p.nullifiers[0]);
        pub[5] = bytes32(p.nullifiers[1]);
        pub[6] = bytes32(p.budgetNullifier);
        pub[7] = bytes32(p.changeCommitment);
        pub[8] = bytes32(p.newBudgetCommitment);
        pub[9] = bytes32(p.refundCore);
        pub[10] = bytes32(p.amount);
        pub[11] = bytes32(p.fee);
        pub[12] = bytes32(uint256(uint160(p.token)));
        pub[13] = bytes32(uint256(uint160(p.recipient)));
        pub[14] = bytes32(uint256(p.timestamp));
        pub[15] = bytes32(context);
    }

    /// Mirrors ShieldedPoolCore._payExtra: the payment options bound into `context`.
    function payExtra(ShieldedPoolCore.PayOptions memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o.mode, o.arbiter, o.claimableAt, o.expiresAt, o.payerAuth, keccak256(o.encryptedRefund)));
    }

    function deposit(address who, uint256 amount, uint256 inner) internal returns (uint256 label, uint256 cm, uint256 leaf) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        (label, cm, leaf) = pool.deposit(address(usdc), amount, inner, "");
        vm.stopPrank();
    }
}
