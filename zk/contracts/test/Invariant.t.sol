// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {ShieldedPoolCore} from "../src/ShieldedPoolCore.sol";
import {PaymentBook, PaymentRecord} from "../src/PaymentBook.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SoundMockVerifier} from "./helpers/SoundMockVerifier.sol";
import {PoolFixture} from "./helpers/PoolFixture.sol";

/// Drives the pool with random sequences of operations. It "proves" only statements that
/// the circuits would accept (value conservation, owning an unspent note), by declaring
/// them to a SoundMockVerifier, and keeps a ghost model of every unspent note.
contract PoolHandler is Test {
    ShieldedPool immutable pool;
    MockUSDC immutable usdc;
    SoundMockVerifier immutable vTransact;
    SoundMockVerifier immutable vRagequit;

    struct GhostNote {
        uint256 amount;
        uint256 label;
        bool spent;
    }

    GhostNote[] public notes;
    uint256 public unspentValue;
    uint256 public pendingAuthValue;
    uint256 public successfulReplays; // MUST stay 0
    uint256 public paidOut;
    uint256 nonce = 1;
    mapping(uint256 => uint256) noteNullifier;
    bytes32[] public pendingDigests;
    mapping(bytes32 => uint256) digestValue;
    mapping(bytes32 => uint256) digestNote;
    mapping(bytes32 => uint256) digestLabel;

    // refundable / escrowed payments (the handler itself is the merchant and the arbiter)
    struct Pay {
        uint256 id;
        PaymentRecord rec;
        uint256 label;
        uint256 refunded;
        bool closed;
    }

    Pay[] public pays;
    uint256 public escrowValue; // funds the PaymentBook must hold
    uint256 public merchantBalance; // what the handler holds: merchant receipts + ragequits
    uint256 public successfulOverRefunds; // MUST stay 0
    bytes32 constant RELEASE = keccak256("r");
    bytes32 constant DISPUTE = keccak256("d");

    constructor(ShieldedPool p, MockUSDC u, SoundMockVerifier vt, SoundMockVerifier vr) {
        pool = p;
        usdc = u;
        vTransact = vt;
        vRagequit = vr;
    }

    function _pub(ShieldedPoolCore.TransactInputs memory t, bool deferred, uint256 ctx) internal pure returns (bytes32[] memory pub) {
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
        pub[11] = bytes32(ctx);
    }

    function _ext() internal view returns (ShieldedPoolCore.ExtData memory e) {
        e.feeRecipient = address(0xFEE);
        e.deadline = uint64(block.timestamp + 600);
    }

    function _pickUnspent(uint256 seed) internal view returns (bool found, uint256 idx) {
        uint256 n = notes.length;
        if (n == 0) return (false, 0);
        for (uint256 k; k < n; ++k) {
            uint256 i = (seed % n + k) % n;
            if (!notes[i].spent) return (true, i);
        }
        return (false, 0);
    }

    function _newNote(uint256 amount, uint256 label) internal returns (uint256 idx) {
        notes.push(GhostNote(amount, label, false));
        idx = notes.length - 1;
        noteNullifier[idx] = uint256(keccak256(abi.encode("nf", idx, nonce++))) % 1e70 + 1;
        unspentValue += amount;
    }

    function _payExtra(ShieldedPoolCore.PayOptions memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o.mode, o.arbiter, o.claimableAt, o.expiresAt, o.payerAuth, keccak256(o.encryptedRefund)));
    }

    // ---- actions ----

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(pool), amount);
        (uint256 label,,) = pool.deposit(address(usdc), amount, nonce++, "");
        _newNote(amount, label);
    }

    /// Spend one note: pay `pay` publicly, `fee` to relayer, keep change as a new note.
    function spend(uint256 seed, uint256 pay, uint256 fee) external {
        (bool ok, uint256 i) = _pickUnspent(seed);
        if (!ok) return;
        GhostNote storage g = notes[i];
        pay = bound(pay, 0, g.amount);
        fee = bound(fee, 0, g.amount - pay);
        uint256 change = g.amount - pay - fee;
        ShieldedPoolCore.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = pay;
        t.fee = fee;
        t.token = address(usdc);
        t.recipient = pay == 0 ? address(0) : address(0xBEEF);
        ShieldedPoolCore.ExtData memory e = _ext();
        vTransact.declareTrue(_pub(t, false, pool.computeContext(1, e, 0)));
        pool.transact("", t, e);
        g.spent = true;
        unspentValue -= g.amount;
        paidOut += pay + fee;
        _newNote(change, g.label);
    }

    /// Try to re-spend an already spent note (fresh outputs, current root). Must revert.
    function replay(uint256 seed) external {
        uint256 n = notes.length;
        if (n == 0) return;
        uint256 i = seed % n;
        if (!notes[i].spent) return;
        ShieldedPoolCore.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy-r", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = notes[i].amount;
        t.token = address(usdc);
        t.recipient = address(0xBAD);
        ShieldedPoolCore.ExtData memory e = _ext();
        vTransact.declareTrue(_pub(t, false, pool.computeContext(1, e, 0)));
        try pool.transact("", t, e) {
            successfulReplays++;
        } catch {}
    }

    function ragequit(uint256 seed) external {
        (bool ok, uint256 i) = _pickUnspent(seed);
        if (!ok || notes[i].amount == 0) return;
        GhostNote storage g = notes[i];
        uint256 root = pool.root();
        bytes32[] memory pub = new bytes32[](5);
        pub[0] = bytes32(root);
        pub[1] = bytes32(noteNullifier[i]);
        pub[2] = bytes32(g.amount);
        pub[3] = bytes32(uint256(uint160(address(usdc))));
        pub[4] = bytes32(g.label);
        vRagequit.declareTrue(pub);
        pool.ragequit("", root, noteNullifier[i], g.amount, address(usdc), g.label);
        g.spent = true;
        unspentValue -= g.amount;
        paidOut += g.amount;
        merchantBalance += g.amount; // ragequit pays the depositor = this handler
    }

    /// Path B: reserve part of a note for an EIP-3009 transfer; change stays private.
    function authorize(uint256 seed, uint256 value) external {
        (bool ok, uint256 i) = _pickUnspent(seed);
        if (!ok || notes[i].amount == 0) return;
        GhostNote storage g = notes[i];
        value = bound(value, 1, g.amount);
        ShieldedPoolCore.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy-a", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = value;
        t.token = address(usdc);
        t.recipient = address(0xC0FFEE);
        ShieldedPoolCore.ExtData memory e = _ext();
        ShieldedPoolCore.Authorization3009 memory a =
            ShieldedPoolCore.Authorization3009(0, block.timestamp + 300, bytes32(nonce++));
        vTransact.declareTrue(_pub(t, true, pool.computeContext(4, e, keccak256(abi.encode(a.validAfter, a.validBefore, a.nonce)))));
        bytes32 digest = pool.authorizeTransfer("", t, e, a);
        g.spent = true;
        unspentValue -= g.amount;
        _newNote(g.amount - value, g.label); // change
        pendingAuthValue += value;
        pendingDigests.push(digest);
        digestValue[digest] = value;
        digestNote[digest] = uint256(a.nonce);
        digestLabel[digest] = g.label; // the refund core inherits the deposit label
    }

    /// Refundable (mode 1) or escrowed (mode 2) payment of part of a note to the handler.
    function payMerchant(uint256 seed, uint256 amount, bool escrow) external {
        (bool ok, uint256 i) = _pickUnspent(seed);
        if (!ok || notes[i].amount == 0) return;
        GhostNote storage g = notes[i];
        amount = bound(amount, 1, g.amount);
        ShieldedPoolCore.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy-p", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++]; // [change, refund core]
        t.publicAmount = amount;
        t.token = address(usdc);
        t.recipient = address(this);
        ShieldedPoolCore.ExtData memory e = _ext();
        ShieldedPoolCore.PayOptions memory o;
        o.mode = escrow ? 2 : 1;
        if (escrow) {
            o.arbiter = address(this);
            o.claimableAt = uint64(block.timestamp + 1 hours);
            o.expiresAt = uint64(block.timestamp + 1 days);
            o.payerAuth = keccak256(abi.encode(keccak256(abi.encode(RELEASE)), keccak256(abi.encode(DISPUTE))));
        }
        vTransact.declareTrue(_pub(t, true, pool.computeContext(6, e, _payExtra(o))));
        pool.pay("", t, e, o);
        g.spent = true;
        unspentValue -= g.amount;
        _newNote(g.amount - amount, g.label);
        pays.push(Pay({
            id: t.nullifiers[0],
            rec: PaymentRecord({
                mode: o.mode, vendorChecked: false, merchant: address(this), token: address(usdc), amount: uint128(amount),
                refundCore: t.outCommitments[1], arbiter: o.arbiter, claimableAt: o.claimableAt, expiresAt: o.expiresAt,
                payerAuth: o.payerAuth
            }),
            label: g.label,
            refunded: 0,
            closed: false
        }));
        if (escrow) escrowValue += amount;
        else merchantBalance += amount;
    }

    /// The merchant refunds part of a refundable payment; an over-refund must never succeed.
    function merchantRefund(uint256 seed, uint256 amount) external {
        if (pays.length == 0) return;
        Pay storage p = pays[seed % pays.length];
        if (p.closed || p.rec.mode != 1) return;
        PaymentBook book = pool.paymentBook();
        usdc.approve(address(book), type(uint256).max);
        uint256 left = p.rec.amount - p.refunded;
        try book.refund(p.id, p.rec, uint128(left + 1)) {
            successfulOverRefunds++;
        } catch {}
        amount = bound(amount, 1, left);
        book.refund(p.id, p.rec, uint128(amount));
        p.refunded += amount;
        if (p.refunded == p.rec.amount) p.closed = true;
        merchantBalance -= amount;
        _newNote(amount, p.label); // refund note keeps the lineage
    }

    /// Close an escrow: 0 payer releases, 1 merchant claims (partial refund), 2 dispute + arbiter
    /// split, 3 expiry refund.
    function settleEscrow(uint256 seed, uint8 how, uint256 split) external {
        if (pays.length == 0) return;
        Pay storage p = pays[seed % pays.length];
        if (p.closed || p.rec.mode != 2) return;
        PaymentBook book = pool.paymentBook();
        uint256 amt = p.rec.amount;
        split = bound(split, 0, amt);
        uint256 toMerchant;
        how = how % 4;
        if (how == 2 && block.timestamp >= p.rec.claimableAt) how = 3;
        if (how == 0) {
            book.releaseEscrow(p.id, p.rec, RELEASE, keccak256(abi.encode(DISPUTE)));
            toMerchant = amt;
        } else if (how == 1) {
            if (block.timestamp >= p.rec.expiresAt) return;
            if (block.timestamp < p.rec.claimableAt) vm.warp(p.rec.claimableAt);
            book.claimEscrow(p.id, p.rec, uint128(amt - split));
            toMerchant = split;
        } else if (how == 2) {
            book.disputeEscrow(p.id, p.rec, DISPUTE, keccak256(abi.encode(RELEASE)));
            book.resolveEscrow(p.id, p.rec, uint128(split));
            toMerchant = split;
        } else {
            if (block.timestamp < p.rec.expiresAt) vm.warp(p.rec.expiresAt);
            book.expireEscrow(p.id, p.rec);
        }
        p.closed = true;
        escrowValue -= amt;
        merchantBalance += toMerchant;
        if (amt > toMerchant) _newNote(amt - toMerchant, p.label);
    }

    /// The merchant's facilitator executes a pending authorization, or it expires and is reclaimed.
    function resolveAuthorization(uint256 seed, bool execute) external {
        uint256 n = pendingDigests.length;
        if (n == 0) return;
        uint256 k = seed % n;
        bytes32 digest = pendingDigests[k];
        uint256 value = digestValue[digest];
        (, uint64 validBefore,,,,) = pool.pendingAuthorizations(digest);
        if (execute && block.timestamp < validBefore) {
            usdc.transferWithAuthorization(address(pool), address(0xC0FFEE), value, 0, validBefore, bytes32(digestNote[digest]), hex"00");
            paidOut += value;
        } else {
            if (block.timestamp < validBefore) vm.warp(validBefore);
            pool.reclaimAuthorization(digest);
            _newNote(value, digestLabel[digest]); // refund note keeps the lineage
        }
        pendingAuthValue -= value;
        pendingDigests[k] = pendingDigests[n - 1];
        pendingDigests.pop();
    }
}

contract PoolInvariantTest is PoolFixture {
    PoolHandler handler;

    function setUp() public {
        setUpPool();
        handler = new PoolHandler(pool, usdc, vTransact, vRagequit);
        targetContract(address(handler));
    }

    /// Solvency: the pool holds exactly the value of all unspent notes plus reserved Path-B
    /// authorizations. (No note can be created from nothing, none can be spent twice.)
    function invariant_poolBalanceEqualsUnspentNotesPlusPending() public view {
        assertEq(usdc.balanceOf(address(pool)), handler.unspentValue() + handler.pendingAuthValue());
    }

    /// Escrowed funds sit in the PaymentBook, exactly; refunds never exceed what was paid.
    function invariant_bookHoldsOpenEscrows_andNoOverRefund() public view {
        assertEq(usdc.balanceOf(address(pool.paymentBook())), handler.escrowValue());
        assertEq(usdc.balanceOf(address(handler)), handler.merchantBalance());
        assertEq(handler.successfulOverRefunds(), 0);
    }

    function invariant_noReplayEverSucceeds() public view {
        assertEq(handler.successfulReplays(), 0);
    }

    function invariant_currentRootAlwaysKnown_andTreeAligned() public view {
        assertTrue(pool.isKnownRoot(pool.root()));
        assertEq(pool.nextIndex() % 2, 0, "every insertion is a 2-leaf pair");
    }
}
