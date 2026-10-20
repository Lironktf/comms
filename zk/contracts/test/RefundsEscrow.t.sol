// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {ShieldedPoolCore} from "../src/ShieldedPoolCore.sol";
import {PaymentBook, PaymentRecord} from "../src/PaymentBook.sol";
import {ShieldedHashes} from "../src/libraries/ShieldedHashes.sol";
import {PoolFixture} from "./helpers/PoolFixture.sol";

/// Refundable and escrowed payments, with SoundMockVerifiers (real proofs: client e2e tests).
contract RefundsEscrowTest is PoolFixture {
    PaymentBook book;
    address alice = makeAddr("alice");
    address arbiter = makeAddr("arbiter");
    address stranger = makeAddr("stranger");
    uint256 constant REFUND_CORE = 0xC0DE;
    bytes32 constant RELEASE = keccak256("release-secret");
    bytes32 constant DISPUTE = keccak256("dispute-secret");
    uint256 nf = 100;

    function setUp() public {
        setUpPool();
        book = pool.paymentBook();
        deposit(alice, 100e6, 42);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _auth() internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(abi.encode(RELEASE)), keccak256(abi.encode(DISPUTE))));
    }

    function _refundable() internal pure returns (ShieldedPoolCore.PayOptions memory o) {
        o.mode = 1;
        o.encryptedRefund = hex"0bad";
    }

    function _escrow(address arb, uint64 window, uint64 life) internal view returns (ShieldedPoolCore.PayOptions memory o) {
        o.mode = 2;
        o.arbiter = arb;
        o.claimableAt = uint64(block.timestamp) + window;
        o.expiresAt = uint64(block.timestamp) + life;
        o.payerAuth = _auth();
        o.encryptedRefund = hex"0bad";
    }

    function _inputs(uint256 amount, uint256 fee) internal returns (ShieldedPoolCore.TransactInputs memory t) {
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [nf++, nf++];
        t.outCommitments = [nf++, REFUND_CORE];
        t.publicAmount = amount;
        t.fee = fee;
        t.token = address(usdc);
        t.recipient = merchant;
    }

    /// pay() with a "proof" the mock verifier accepts; returns the id and the record.
    function _pay(uint256 amount, ShieldedPoolCore.PayOptions memory o) internal returns (uint256 id, PaymentRecord memory rec) {
        ShieldedPoolCore.TransactInputs memory t = _inputs(amount, 1e4);
        ShieldedPoolCore.ExtData memory e = ext(relayer, bytes32(uint256(9)));
        vTransact.declareTrue(transactPub(t, true, pool.computeContext(6, e, payExtra(o))));
        pool.pay("", t, e, o);
        id = t.nullifiers[0];
        rec = PaymentRecord({
            mode: o.mode, vendorChecked: false, merchant: merchant, token: address(usdc), amount: uint128(amount),
            refundCore: REFUND_CORE, arbiter: o.arbiter, claimableAt: o.claimableAt, expiresAt: o.expiresAt,
            payerAuth: o.payerAuth
        });
    }

    function _refundCm(uint256 amount) internal view returns (uint256) {
        return ShieldedHashes.commitment(p2, amount, address(usdc), REFUND_CORE);
    }

    // -----------------------------------------------------------------
    // refundable
    // -----------------------------------------------------------------

    function test_refundable_merchantPaidNow_partialThenFullRefund_asPrivateNotes() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _refundable());
        assertEq(usdc.balanceOf(merchant), 5e6, "merchant paid at once");
        assertEq(usdc.balanceOf(relayer), 1e4);
        assertEq(book.recordHash(id), keccak256(abi.encode(rec)));

        vm.startPrank(merchant);
        usdc.approve(address(book), type(uint256).max);
        uint256 before = pool.nextIndex();
        (uint256 cm, uint256 leaf) = book.refund(id, rec, 2e6);
        assertEq(cm, _refundCm(2e6), "refund note = H3(amount, token, refundCore)");
        assertEq(leaf, before);
        assertTrue(pool.isKnownRoot(pool.root()));
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.RefundTooLarge.selector, 4e6, 3e6));
        book.refund(id, rec, 4e6);
        book.refund(id, rec, 3e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.PaymentClosed.selector, id));
        book.refund(id, rec, 1);
        vm.stopPrank();

        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(address(book)), 0, "book never keeps refunded funds");
        assertEq(usdc.balanceOf(address(pool)), 100e6 - 1e4 - 5e6 + 5e6, "refunds back in the pool");
    }

    function test_refund_onlyMerchant_exactRecord_nonzero() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _refundable());
        vm.expectRevert(PaymentBook.NotMerchant.selector);
        vm.prank(stranger);
        book.refund(id, rec, 1e6);
        PaymentRecord memory forged = _copy(rec);
        forged.refundCore = 0xBAD; // redirect the refund note
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.UnknownPayment.selector, id));
        vm.prank(merchant);
        book.refund(id, forged, 1e6);
        forged = _copy(rec);
        forged.amount = 50e6; // claim it was a bigger payment
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.UnknownPayment.selector, id));
        vm.prank(merchant);
        book.refund(id, forged, 10e6);
        vm.expectRevert(PaymentBook.ZeroAmount.selector);
        vm.prank(merchant);
        book.refund(id, rec, 0);
    }

    function test_refundable_rejectsEscrowFields_andDirectModeInPay() public {
        ShieldedPoolCore.PayOptions memory o = _refundable();
        o.expiresAt = uint64(block.timestamp + 100);
        ShieldedPoolCore.TransactInputs memory t = _inputs(1e6, 0);
        ShieldedPoolCore.ExtData memory e = ext(address(0), 0);
        vTransact.declareTrue(transactPub(t, true, pool.computeContext(6, e, payExtra(o))));
        vm.expectRevert(PaymentBook.BadEscrowTerms.selector);
        pool.pay("", t, e, o);
        o = _refundable();
        o.mode = 0;
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.BadPayMode.selector, 0));
        pool.pay("", t, e, o);
        o.mode = 3;
        vm.expectRevert(abi.encodeWithSelector(ShieldedPoolCore.BadPayMode.selector, 3));
        pool.pay("", t, e, o);
    }

    function test_relayerCannotChangePaymentTerms() public {
        // the proof binds the options; a relayer turning an escrow into a refundable payment
        // (merchant paid at once) or swapping the refund ciphertext invalidates it
        ShieldedPoolCore.PayOptions memory o = _escrow(address(0), 1 hours, 2 hours);
        ShieldedPoolCore.TransactInputs memory t = _inputs(1e6, 0);
        ShieldedPoolCore.ExtData memory e = ext(address(0), 0);
        vTransact.declareTrue(transactPub(t, true, pool.computeContext(6, e, payExtra(o))));
        ShieldedPoolCore.PayOptions memory evil = _refundable();
        evil.encryptedRefund = o.encryptedRefund;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        pool.pay("", t, e, evil);
        evil = _copy(o);
        evil.encryptedRefund = hex"beef";
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        pool.pay("", t, e, evil);
        evil = _copy(o);
        evil.claimableAt = o.claimableAt - 1;
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        pool.pay("", t, e, evil);
        pool.pay("", t, e, o);
    }

    // -----------------------------------------------------------------
    // escrow
    // -----------------------------------------------------------------

    function test_escrow_fundsHeldInBook_merchantClaimsAfterWindow() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(address(0), 1 hours, 7 days));
        assertEq(usdc.balanceOf(merchant), 0, "not paid yet");
        assertEq(usdc.balanceOf(address(book)), 5e6);
        vm.startPrank(merchant);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.EscrowNotClaimable.selector, id));
        book.claimEscrow(id, rec, 0);
        vm.warp(rec.claimableAt);
        book.claimEscrow(id, rec, 1e6); // keep 4, refund 1
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), 4e6);
        assertEq(usdc.balanceOf(address(book)), 0);
        assertEq(usdc.balanceOf(address(pool)), 100e6 - 1e4 - 5e6 + 1e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.PaymentClosed.selector, id));
        vm.prank(merchant);
        book.claimEscrow(id, rec, 0);
    }

    function test_escrow_payerReleasesEarly_withSecret_fromAnyAddress() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(address(0), 1 days, 7 days));
        vm.startPrank(stranger);
        vm.expectRevert(PaymentBook.BadPayerSecret.selector);
        book.releaseEscrow(id, rec, DISPUTE, keccak256(abi.encode(RELEASE)));
        book.releaseEscrow(id, rec, RELEASE, keccak256(abi.encode(DISPUTE)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), 5e6);
    }

    function test_escrow_releaseSecretCannotBeUsedToDispute() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(arbiter, 1 days, 7 days));
        // a submitter who saw RELEASE (and thus knows keccak(DISPUTE)) still can't dispute
        vm.expectRevert(PaymentBook.BadPayerSecret.selector);
        book.disputeEscrow(id, rec, RELEASE, keccak256(abi.encode(DISPUTE)));
        vm.expectRevert(PaymentBook.BadPayerSecret.selector);
        book.disputeEscrow(id, rec, keccak256(abi.encode(DISPUTE)), keccak256(abi.encode(RELEASE)));
    }

    function test_escrow_disputeThenArbiterSplits() public {
        (uint256 id, PaymentRecord memory rec) = _pay(10e6, _escrow(arbiter, 1 days, 7 days));
        book.disputeEscrow(id, rec, DISPUTE, keccak256(abi.encode(RELEASE)));
        (uint8 status,) = book.state(id);
        assertEq(status, 1);
        vm.warp(rec.claimableAt + 1);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.EscrowNotClaimable.selector, id));
        vm.prank(merchant);
        book.claimEscrow(id, rec, 0); // disputed: merchant can't collect
        vm.expectRevert(PaymentBook.NotArbiter.selector);
        vm.prank(merchant);
        book.resolveEscrow(id, rec, 10e6);
        vm.prank(arbiter);
        book.resolveEscrow(id, rec, 3e6);
        assertEq(usdc.balanceOf(merchant), 3e6);
        assertEq(usdc.balanceOf(address(pool)), 100e6 - 1e4 - 10e6 + 7e6);
    }

    function test_escrow_disputeRules() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(address(0), 1 days, 7 days));
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.NoArbiter.selector, id));
        book.disputeEscrow(id, rec, DISPUTE, keccak256(abi.encode(RELEASE)));
        (uint256 id2, PaymentRecord memory rec2) = _pay(5e6, _escrow(arbiter, 1 days, 7 days));
        vm.warp(rec2.claimableAt);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.DisputeWindowOver.selector, id2));
        book.disputeEscrow(id2, rec2, DISPUTE, keccak256(abi.encode(RELEASE)));
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.NotDisputed.selector, id2));
        vm.prank(arbiter);
        book.resolveEscrow(id2, rec2, 0);
    }

    function test_escrow_unresolvedDisputeExpiresToPayer() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(arbiter, 1 days, 7 days));
        book.disputeEscrow(id, rec, DISPUTE, keccak256(abi.encode(RELEASE)));
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.NotExpired.selector, id));
        book.expireEscrow(id, rec);
        vm.warp(rec.expiresAt);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.EscrowNotClaimable.selector, id));
        vm.prank(arbiter);
        book.resolveEscrow(id, rec, 5e6); // arbiter too late
        uint256 leaf = pool.nextIndex();
        vm.prank(stranger);
        book.expireEscrow(id, rec);
        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(address(pool)), 100e6 - 1e4);
        assertEq(pool.nextIndex(), leaf + 2, "refund note inserted");
    }

    function test_escrow_merchantCanCancelAnytime_butNotClaimAfterExpiry() public {
        (uint256 id, PaymentRecord memory rec) = _pay(5e6, _escrow(arbiter, 1 days, 7 days));
        (uint256 id2, PaymentRecord memory rec2) = _pay(5e6, _escrow(arbiter, 1 days, 7 days));
        book.disputeEscrow(id, rec, DISPUTE, keccak256(abi.encode(RELEASE)));
        vm.prank(merchant);
        book.claimEscrow(id, rec, 5e6); // full refund while disputed: allowed
        vm.warp(rec2.expiresAt);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.EscrowNotClaimable.selector, id2));
        vm.prank(merchant);
        book.claimEscrow(id2, rec2, 0);
    }

    function test_escrow_badTerms() public {
        ShieldedPoolCore.TransactInputs memory t = _inputs(1e6, 0);
        ShieldedPoolCore.ExtData memory e = ext(address(0), 0);
        ShieldedPoolCore.PayOptions[4] memory bad;
        bad[0] = _escrow(address(0), 1 days, 1 days); // expires == claimable
        bad[1] = _escrow(address(0), 0, 91 days); // > MAX_ESCROW_DURATION
        bad[2] = _escrow(address(0), 1 days, 2 days);
        bad[2].payerAuth = 0; // payer could never act
        bad[3] = _escrow(address(0), 1 days, 2 days);
        bad[3].claimableAt = uint64(block.timestamp - 1);
        for (uint256 i; i < 4; ++i) {
            vTransact.declareTrue(transactPub(t, true, pool.computeContext(6, e, payExtra(bad[i]))));
            vm.expectRevert(PaymentBook.BadEscrowTerms.selector);
            pool.pay("", t, e, bad[i]);
        }
    }

    function test_book_onlyPoolOpens_onlyBookShields() public {
        PaymentRecord memory rec;
        vm.expectRevert(PaymentBook.NotPool.selector);
        book.open(1, rec, 0, "");
        vm.expectRevert(ShieldedPoolCore.NotPaymentBook.selector);
        pool.shieldRefund(1, address(usdc), 1, 1);
    }

    // -----------------------------------------------------------------
    // policy payments: refund slot + vendor check at claim time
    // -----------------------------------------------------------------

    function _registerMerchant() internal {
        string[] memory none = new string[](0);
        address[] memory w = new address[](1);
        w[0] = merchant;
        vm.prank(merchant);
        vendors.registerVendor("merchant.example", none, w, "", bytes32(0), "");
        // vendorRoot = the tree's current (known) root; membership itself is the circuit's job
    }

    function _copy(PaymentRecord memory r) internal pure returns (PaymentRecord memory) {
        return abi.decode(abi.encode(r), (PaymentRecord));
    }

    function _copy(ShieldedPoolCore.PayOptions memory o) internal pure returns (ShieldedPoolCore.PayOptions memory) {
        return abi.decode(abi.encode(o), (ShieldedPoolCore.PayOptions));
    }

    function _policyInputs(uint256 amount) internal returns (ShieldedPoolCore.PolicyInputs memory p) {
        p.root = pool.root();
        p.aspRoot = 777;
        p.vendorRoot = vendorTree.root();
        p.vendorChecked = true;
        p.nullifiers = [nf++, nf++];
        p.budgetNullifier = nf++;
        p.changeCommitment = nf++;
        p.newBudgetCommitment = nf++;
        p.refundCore = REFUND_CORE;
        p.amount = amount;
        p.token = address(usdc);
        p.recipient = merchant;
        p.timestamp = uint64(block.timestamp);
    }

    function test_policyEscrow_suspendedVendorCannotCollect_payerGetsItBack() public {
        _registerMerchant();
        ShieldedPoolCore.PayOptions memory o = _escrow(address(0), 1 hours, 2 days);
        ShieldedPoolCore.PolicyInputs memory p = _policyInputs(2e6);
        ShieldedPoolCore.ExtData memory e = ext(address(0), bytes32(uint256(5)));
        vPolicy.declareTrue(policyPub(p, pool.computeContext(2, e, payExtra(o))));
        pool.payWithPolicy("", p, e, o);
        PaymentRecord memory rec = PaymentRecord({
            mode: 2, vendorChecked: true, merchant: merchant, token: address(usdc), amount: 2e6, refundCore: REFUND_CORE,
            arbiter: address(0), claimableAt: o.claimableAt, expiresAt: o.expiresAt, payerAuth: o.payerAuth
        });
        uint256 id = p.nullifiers[0];
        assertEq(book.recordHash(id), keccak256(abi.encode(rec)));
        vendors.grantRole(vendors.GUARDIAN_ROLE(), admin);
        vendors.suspendVendor(vendors.vendorIdForWallet(merchant), "fraud"); // live, instant
        vm.warp(o.claimableAt);
        vm.expectRevert(abi.encodeWithSelector(PaymentBook.VendorNotActive.selector, merchant));
        vm.prank(merchant);
        book.claimEscrow(id, rec, 0);
        vm.warp(o.expiresAt);
        book.expireEscrow(id, rec);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_policyDirect_recordsNothing_policyRefundCoreIsPublicInput() public {
        _registerMerchant();
        ShieldedPoolCore.PayOptions memory o; // DIRECT
        ShieldedPoolCore.PolicyInputs memory p = _policyInputs(1e6);
        ShieldedPoolCore.ExtData memory e = ext(address(0), bytes32(uint256(6)));
        vPolicy.declareTrue(policyPub(p, pool.computeContext(2, e, payExtra(o))));
        p.refundCore = 0xBAD; // not what was "proven"
        vm.expectRevert(ShieldedPoolCore.InvalidProof.selector);
        pool.payWithPolicy("", p, e, o);
        p.refundCore = REFUND_CORE;
        pool.payWithPolicy("", p, e, o);
        assertEq(usdc.balanceOf(merchant), 1e6);
        assertEq(book.recordHash(p.nullifiers[0]), bytes32(0));
    }

    // -----------------------------------------------------------------
    // mixed batch
    // -----------------------------------------------------------------

    function test_batch_mixesTransactPayAndPolicy_inOneTreeInsertion() public {
        _registerMerchant();
        ShieldedPoolCore.TransactCall[] memory ts = new ShieldedPoolCore.TransactCall[](1);
        ShieldedPoolCore.PayCall[] memory ps = new ShieldedPoolCore.PayCall[](2);
        ShieldedPoolCore.PolicyCall[] memory qs = new ShieldedPoolCore.PolicyCall[](1);

        ts[0].inputs = _inputs(1e6, 0);
        ts[0].inputs.outCommitments = [nf++, nf++];
        ts[0].ext = ext(address(0), bytes32(uint256(1)));
        vTransact.declareTrue(transactPub(ts[0].inputs, false, pool.computeContext(1, ts[0].ext, 0)));

        ps[0].inputs = _inputs(2e6, 0);
        ps[0].ext = ext(address(0), bytes32(uint256(2)));
        ps[0].opts = _refundable();
        ps[1].inputs = _inputs(3e6, 0);
        ps[1].ext = ext(address(0), bytes32(uint256(3)));
        ps[1].opts = _escrow(address(0), 1 hours, 1 days);
        for (uint256 i; i < 2; ++i) {
            vTransact.declareTrue(transactPub(ps[i].inputs, true, pool.computeContext(6, ps[i].ext, payExtra(ps[i].opts))));
        }

        qs[0].inputs = _policyInputs(4e6);
        qs[0].ext = ext(address(0), bytes32(uint256(4)));
        vPolicy.declareTrue(policyPub(qs[0].inputs, pool.computeContext(2, qs[0].ext, payExtra(qs[0].opts))));

        uint256 before = pool.nextIndex();
        pool.batch(ts, ps, qs);
        assertEq(pool.nextIndex(), before + 8, "4 calls -> 4 pairs, one insertion");
        assertEq(usdc.balanceOf(merchant), 1e6 + 2e6 + 4e6, "escrowed 3e6 not paid yet");
        assertEq(usdc.balanceOf(address(book)), 3e6);
        assertTrue(pool.nullifierSpent(qs[0].inputs.budgetNullifier));
        assertTrue(book.recordHash(ps[0].inputs.nullifiers[0]) != 0);
        assertTrue(book.recordHash(ps[1].inputs.nullifiers[0]) != 0);

        vm.expectRevert(ShieldedPoolCore.EmptyBatch.selector);
        pool.batch(new ShieldedPoolCore.TransactCall[](0), new ShieldedPoolCore.PayCall[](0), new ShieldedPoolCore.PolicyCall[](0));
    }
}
