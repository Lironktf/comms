// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {ShieldedPoolCore} from "../src/ShieldedPoolCore.sol";
import {AggregationModule} from "../src/AggregationModule.sol";
import {PaymentBook, PaymentRecord} from "../src/PaymentBook.sol";
import {IHonkVerifier} from "../src/interfaces/IHonkVerifier.sol";
import {PoolFixture} from "./helpers/PoolFixture.sol";

/// settleAggregated (docs/aggregation.md) with SoundMockVerifiers: the aggregate verifier accepts
/// exactly the digests a test declares, i.e. the payments a real aggregate proof was made for.
/// The real aggregate verifiers are tested against real proofs in Verifiers.t.sol, and the whole
/// path with real proofs in the client e2e tests.
contract AggregationTest is PoolFixture {
    AggregationModule agg; // the pool, seen through the module's ABI
    PaymentBook book;
    address alice = makeAddr("alice");
    address merchantB = makeAddr("merchantB");
    address relayer2 = makeAddr("relayer2");
    uint256 nf = 1000;

    bytes32 constant USDC_TRANSFER = keccak256("Transfer(address,address,uint256)");

    function setUp() public {
        setUpPool();
        agg = AggregationModule(address(pool));
        book = pool.paymentBook();
        deposit(alice, 1_000e6, 42);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _direct(address to, uint256 amount, uint256 fee) internal returns (AggregationModule.AggPayment memory p) {
        p.inputs.root = pool.root();
        p.inputs.aspRoot = 777;
        p.inputs.nullifiers = [nf++, nf++];
        p.inputs.outCommitments = [nf++, nf++];
        p.inputs.publicAmount = amount;
        p.inputs.fee = fee;
        p.inputs.token = address(usdc);
        p.inputs.recipient = to;
        p.ext = ext(fee == 0 ? address(0) : relayer, bytes32(nf++));
    }

    function _deferred(address to, uint256 amount, uint256 fee, uint8 mode)
        internal
        returns (AggregationModule.AggPayment memory p)
    {
        p = _direct(to, amount, fee);
        p.deferred = true;
        p.opts.mode = mode;
        p.opts.encryptedRefund = hex"0bad";
        if (mode == 2) {
            p.opts.claimableAt = uint64(block.timestamp + 1 hours);
            p.opts.expiresAt = uint64(block.timestamp + 2 hours);
            p.opts.payerAuth = keccak256("auth");
        }
    }

    function _pub(AggregationModule.AggPayment memory p) internal view returns (bytes32[] memory) {
        uint256 context = p.deferred
            ? pool.computeContext(6, p.ext, payExtra(p.opts))
            : pool.computeContext(1, p.ext, bytes32(0));
        return transactPub(p.inputs, p.deferred, context);
    }

    /// The digest the aggregation circuits commit to (mirrors circuits/agg and the module).
    function _digest(AggregationModule.AggPayment[] memory ps) internal view returns (bytes32) {
        uint256 n = ps.length;
        uint256[] memory level = new uint256[](n / 2);
        for (uint256 i; i < n; i += 2) {
            level[i / 2] = uint256(keccak256(abi.encodePacked(_pub(ps[i]), _pub(ps[i + 1])))) % FIELD;
        }
        for (uint256 w = n / 2; w > 1; w /= 2) {
            for (uint256 i; i < w; i += 2) level[i / 2] = uint256(keccak256(abi.encodePacked(level[i], level[i + 1]))) % FIELD;
        }
        return bytes32(level[0]);
    }

    function _verifierFor(uint256 n) internal view returns (uint256) {
        return n == 2 ? 0 : n == 4 ? 1 : 2;
    }

    /// "Prove" the payments: the matching-size aggregate verifier now accepts their digest.
    function _prove(AggregationModule.AggPayment[] memory ps) internal {
        bytes32[] memory pub = new bytes32[](1);
        pub[0] = _digest(ps);
        vAgg[_verifierFor(ps.length)].declareTrue(pub);
    }

    function _directs(uint256 n) internal returns (AggregationModule.AggPayment[] memory ps) {
        ps = new AggregationModule.AggPayment[](n);
        for (uint256 i; i < n; ++i) ps[i] = _direct(i % 2 == 0 ? merchant : merchantB, (i + 1) * 1e6, 1e4);
    }

    // -----------------------------------------------------------------
    // valid batches
    // -----------------------------------------------------------------

    function _settleValid(uint256 n) internal {
        AggregationModule.AggPayment[] memory ps = _directs(n);
        _prove(ps);
        uint256 next = pool.nextIndex();
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 g = gasleft();
        agg.settleAggregated("", ps);
        emit log_named_uint(string.concat("settleAggregated N=", vm.toString(n), " gas (mock verifier)"), g - gasleft());

        uint256 toA;
        uint256 toB;
        for (uint256 i; i < n; ++i) {
            assertTrue(pool.nullifierSpent(ps[i].inputs.nullifiers[0]) && pool.nullifierSpent(ps[i].inputs.nullifiers[1]));
            if (i % 2 == 0) toA += (i + 1) * 1e6;
            else toB += (i + 1) * 1e6;
        }
        assertEq(usdc.balanceOf(merchant), toA);
        assertEq(usdc.balanceOf(merchantB), toB);
        assertEq(usdc.balanceOf(relayer), n * 1e4);
        assertEq(poolBefore - usdc.balanceOf(address(pool)), toA + toB + n * 1e4);
        assertEq(pool.nextIndex(), next + 2 * n, "one tree insertion of 2 leaves per payment");
        assertTrue(pool.isKnownRoot(pool.root()));
    }

    function test_settle_2() public {
        _settleValid(2);
    }

    function test_settle_4() public {
        _settleValid(4);
    }

    function test_settle_8() public {
        _settleValid(8);
    }

    function test_settle_mixesDirectRefundableAndEscrow() public {
        AggregationModule.AggPayment[] memory ps = new AggregationModule.AggPayment[](4);
        ps[0] = _direct(merchant, 1e6, 1e4);
        ps[1] = _deferred(merchant, 2e6, 1e4, 1); // refundable: merchant paid now
        ps[2] = _deferred(merchantB, 3e6, 1e4, 2); // escrow: funds wait in the book
        ps[3] = _direct(address(0), 0, 0); // private transfer: nothing paid out
        _prove(ps);
        uint256 next = pool.nextIndex();
        agg.settleAggregated("", ps);

        assertEq(usdc.balanceOf(merchant), 3e6);
        assertEq(usdc.balanceOf(merchantB), 0);
        assertEq(usdc.balanceOf(address(book)), 3e6);
        assertEq(usdc.balanceOf(relayer), 3e4);
        assertEq(pool.nextIndex(), next + 8);
        // refund slot and escrow are recorded exactly as `pay` records them (id = first nullifier)
        for (uint256 i = 1; i <= 2; ++i) {
            AggregationModule.AggPayment memory p = ps[i];
            PaymentRecord memory rec = PaymentRecord({
                mode: p.opts.mode, vendorChecked: false, merchant: p.inputs.recipient, token: address(usdc),
                amount: uint128(p.inputs.publicAmount), refundCore: p.inputs.outCommitments[1], arbiter: p.opts.arbiter,
                claimableAt: p.opts.claimableAt, expiresAt: p.opts.expiresAt, payerAuth: p.opts.payerAuth
            });
            assertEq(book.recordHash(p.inputs.nullifiers[0]), keccak256(abi.encode(rec)));
        }
        // the deferred out1 (refund core) is not inserted: leaf is 0, as in `pay`
        vm.prank(merchant);
        usdc.approve(address(book), 1e6);
        PaymentRecord memory r1 = PaymentRecord({
            mode: 1, vendorChecked: false, merchant: merchant, token: address(usdc), amount: 2e6,
            refundCore: ps[1].inputs.outCommitments[1], arbiter: address(0), claimableAt: 0, expiresAt: 0, payerAuth: 0
        });
        vm.prank(merchant);
        book.refund(ps[1].inputs.nullifiers[0], r1, 1e6); // the refund path works on an aggregated payment
        assertEq(usdc.balanceOf(merchant), 2e6);
    }

    // -----------------------------------------------------------------
    // tampering after proving
    // -----------------------------------------------------------------

    function test_rejects_tamperedAmount() public {
        AggregationModule.AggPayment[] memory ps = _directs(4);
        _prove(ps);
        ps[2].inputs.publicAmount += 1;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_tamperedRecipient() public {
        AggregationModule.AggPayment[] memory ps = _directs(4);
        _prove(ps);
        ps[1].inputs.recipient = makeAddr("thief");
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_tamperedNullifier() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        _prove(ps);
        ps[0].inputs.nullifiers[1] = 7;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_tamperedExtAndOptions() public {
        AggregationModule.AggPayment[] memory ps = new AggregationModule.AggPayment[](2);
        ps[0] = _direct(merchant, 1e6, 1e4);
        ps[1] = _deferred(merchant, 1e6, 1e4, 2);
        _prove(ps);
        // fee redirected to another relayer (ext is bound through context)
        AggregationModule.AggPayment memory saved = ps[0];
        ps[0].ext.feeRecipient = relayer2;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
        ps[0] = saved;
        // escrow turned into a refundable payment (opts are bound through context)
        ps[1].opts.mode = 1;
        ps[1].opts.claimableAt = 0;
        ps[1].opts.expiresAt = 0;
        ps[1].opts.payerAuth = 0;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
        // a pay statement presented as a transact (deferred is a public input)
        ps[1] = _deferred(merchant, 1e6, 1e4, 2);
        _prove(ps);
        ps[1].deferred = false;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_droppedPayment() public {
        AggregationModule.AggPayment[] memory ps = _directs(4);
        _prove(ps);
        // 3 left: no aggregate circuit for that size
        AggregationModule.AggPayment[] memory three = new AggregationModule.AggPayment[](3);
        for (uint256 i; i < 3; ++i) three[i] = ps[i];
        vm.expectRevert(abi.encodeWithSelector(AggregationModule.BadAggregateSize.selector, 3));
        agg.settleAggregated("", three);
        // 2 left: the size-2 verifier never saw these two as a pair
        AggregationModule.AggPayment[] memory two = new AggregationModule.AggPayment[](2);
        two[0] = ps[0];
        two[1] = ps[1];
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", two);
    }

    function test_rejects_reorderedPayments() public {
        AggregationModule.AggPayment[] memory ps = _directs(4);
        _prove(ps);
        (ps[0], ps[3]) = (ps[3], ps[0]);
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
        (ps[0], ps[3]) = (ps[3], ps[0]);
        (ps[0], ps[1]) = (ps[1], ps[0]); // swapped within one leaf pair
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_wrongVerifierKey() public {
        // a valid proof for these 2 payments, but under the size-4 key: the size-2 verifier rejects it
        AggregationModule.AggPayment[] memory ps = _directs(2);
        bytes32[] memory pub = new bytes32[](1);
        pub[0] = _digest(ps);
        vAgg[1].declareTrue(pub);
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
        // and the transact verifier's statements mean nothing to the aggregate verifier
        vTransact.declareTrue(_pub(ps[0]));
        vTransact.declareTrue(_pub(ps[1]));
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        agg.settleAggregated("", ps);
    }

    // -----------------------------------------------------------------
    // state checks (same as transact / pay)
    // -----------------------------------------------------------------

    function test_rejects_nullifierReusedAcrossBatches() public {
        AggregationModule.AggPayment[] memory a = _directs(2);
        _prove(a);
        agg.settleAggregated("", a);
        AggregationModule.AggPayment[] memory b = _directs(2);
        b[1].inputs.nullifiers[0] = a[0].inputs.nullifiers[1];
        _prove(b);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.NullifierSpent.selector, a[0].inputs.nullifiers[1]));
        agg.settleAggregated("", b);
    }

    function test_rejects_nullifierReusedWithinBatch() public {
        AggregationModule.AggPayment[] memory ps = _directs(4);
        ps[3].inputs.nullifiers[1] = ps[1].inputs.nullifiers[0];
        _prove(ps);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.NullifierSpent.selector, ps[1].inputs.nullifiers[0]));
        agg.settleAggregated("", ps);
        // and within one payment
        ps = _directs(2);
        ps[0].inputs.nullifiers[1] = ps[0].inputs.nullifiers[0];
        _prove(ps);
        vm.expectRevert(ShieldedPoolCore.DuplicateNullifier.selector);
        agg.settleAggregated("", ps);
    }

    function test_rejects_nullifierAlreadySpentThroughTransact_andViceVersa() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        _prove(ps);
        agg.settleAggregated("", ps);
        // the escape hatch can't replay an aggregated payment
        ShieldedPoolCore.TransactInputs memory t = ps[0].inputs;
        t.root = pool.root();
        vTransact.declareTrue(transactPub(t, false, pool.computeContext(1, ps[0].ext, bytes32(0))));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.NullifierSpent.selector, t.nullifiers[0]));
        pool.transact("", t, ps[0].ext);
    }

    function test_rejects_unknownRoot() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        ps[1].inputs.root = 12345;
        _prove(ps);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.UnknownRoot.selector, 12345));
        agg.settleAggregated("", ps);
    }

    function test_rejects_invalidAssociationRoot() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        ps[0].inputs.aspRoot = 778;
        _prove(ps);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.InvalidAssociationRoot.selector, 778));
        agg.settleAggregated("", ps);
    }

    function test_rejects_expiredDeadline() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        _prove(ps);
        uint64 deadline = ps[1].ext.deadline;
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.Expired.selector, deadline));
        agg.settleAggregated("", ps);
    }

    function test_rejects_badFeeRecipientAndPayMode() public {
        AggregationModule.AggPayment[] memory ps = _directs(2);
        ps[0].ext.feeRecipient = address(0);
        _prove(ps);
        vm.expectRevert(ShieldedPoolCore.BadFeeRecipient.selector);
        agg.settleAggregated("", ps);
        ps = _directs(2);
        ps[1].deferred = true; // a deferred payment must be REFUNDABLE or ESCROW
        _prove(ps);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.BadPayMode.selector, 0));
        agg.settleAggregated("", ps);
    }

    function test_rejects_emptyAndUnsupportedSizes() public {
        vm.expectRevert(ShieldedPoolCore.EmptyBatch.selector);
        agg.settleAggregated("", new AggregationModule.AggPayment[](0));
        uint8[4] memory bad = [1, 3, 6, 16];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(abi.encodeWithSelector(AggregationModule.BadAggregateSize.selector, bad[i]));
            agg.settleAggregated("", new AggregationModule.AggPayment[](bad[i]));
        }
    }

    function test_module_cannotBeCalledDirectly() public {
        AggregationModule m = AggregationModule(pool.aggregationModule());
        AggregationModule.AggPayment[] memory ps = _directs(2);
        vm.expectRevert(AggregationModule.NotDelegated.selector);
        m.settleAggregated("", ps);
    }

    function test_module_wiringMatchesPool() public view {
        assertEq(address(agg.aggregate2Verifier()), address(vAgg[0]));
        assertEq(address(agg.aggregate4Verifier()), address(vAgg[1]));
        assertEq(address(agg.aggregate8Verifier()), address(vAgg[2]));
        AggregationModule m = AggregationModule(pool.aggregationModule());
        assertEq(address(m.paymentBook()), address(pool.paymentBook()));
        assertEq(address(m.associationSet()), address(pool.associationSet()));
        assertEq(address(m.poseidon2()), address(pool.poseidon2()));
        assertEq(address(m.transactVerifier()), address(pool.transactVerifier()));
    }

    function test_pool_rejectsEtherAndUnknownSelectors() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(pool).call{value: 1}("");
        assertFalse(ok, "no receive");
        (ok,) = address(pool).call(abi.encodeWithSignature("nope()"));
        assertFalse(ok, "unknown selector reverts in the module");
    }

    // -----------------------------------------------------------------
    // netting and events
    // -----------------------------------------------------------------

    function test_netting_oneTransferPerTokenAndRecipient() public {
        AggregationModule.AggPayment[] memory ps = new AggregationModule.AggPayment[](8);
        // merchant x4, merchantB x3, one private transfer; fees to two relayers
        uint256[8] memory amt = [uint256(1e6), 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 0];
        for (uint256 i; i < 7; ++i) {
            ps[i] = _direct(i < 4 ? merchant : merchantB, amt[i], 1e3 * (i + 1));
            if (i >= 5) ps[i].ext.feeRecipient = relayer2;
        }
        ps[7] = _direct(address(0), 0, 0);
        _prove(ps);
        vm.recordLogs();
        agg.settleAggregated("", ps);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 transfers;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(usdc) && logs[i].topics[0] == USDC_TRANSFER) {
                ++transfers;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(pool));
            }
        }
        assertEq(transfers, 4, "merchant, merchantB, relayer, relayer2");
        assertEq(usdc.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(merchantB), 18e6);
        assertEq(usdc.balanceOf(relayer), (1 + 2 + 3 + 4 + 5) * 1e3);
        assertEq(usdc.balanceOf(relayer2), (6 + 7) * 1e3);
    }

    function test_events_onePublicPaymentPerPayment_inOrder() public {
        AggregationModule.AggPayment[] memory ps = new AggregationModule.AggPayment[](4);
        ps[0] = _direct(merchant, 1e6, 1e4);
        ps[1] = _direct(merchantB, 2e6, 0);
        ps[2] = _deferred(merchant, 3e6, 1e4, 1);
        ps[3] = _direct(merchant, 4e6, 1e4);
        _prove(ps);
        uint256 start = pool.nextIndex();
        for (uint256 i; i < 4; ++i) {
            vm.expectEmit(address(pool));
            emit ShieldedPoolCore.NewNullifier(ps[i].inputs.nullifiers[0]);
            vm.expectEmit(address(pool));
            emit ShieldedPoolCore.NewNullifier(ps[i].inputs.nullifiers[1]);
        }
        for (uint256 i; i < 4; ++i) {
            vm.expectEmit(address(pool));
            emit ShieldedPoolCore.NewCommitment(ps[i].inputs.outCommitments[0], start + 2 * i, ps[i].ext.encryptedOutput0);
            if (!ps[i].deferred) {
                vm.expectEmit(address(pool));
                emit ShieldedPoolCore.NewCommitment(ps[i].inputs.outCommitments[1], start + 2 * i + 1, ps[i].ext.encryptedOutput1);
            }
        }
        for (uint256 i; i < 4; ++i) {
            ShieldedPoolCore.TransactInputs memory t = ps[i].inputs;
            vm.expectEmit(address(pool));
            emit ShieldedPoolCore.PublicPayment(ps[i].ext.requestId, t.recipient, t.token, t.publicAmount, t.fee, ps[i].ext.feeRecipient);
        }
        agg.settleAggregated("", ps);
    }

    function test_batch_escapeHatchStillWorks() public {
        // the per-proof path is untouched: anyone can settle their own payment without the aggregator
        AggregationModule.AggPayment memory p = _direct(merchant, 1e6, 0);
        vTransact.declareTrue(_pub(p));
        pool.transact("", p.inputs, p.ext);
        assertEq(usdc.balanceOf(merchant), 1e6);
    }
}
