// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
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

    constructor(ShieldedPool p, MockUSDC u, SoundMockVerifier vt, SoundMockVerifier vr) {
        pool = p;
        usdc = u;
        vTransact = vt;
        vRagequit = vr;
    }

    function _pub(ShieldedPool.TransactInputs memory t, bool deferred, uint256 ctx) internal pure returns (bytes32[] memory pub) {
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

    function _ext() internal view returns (ShieldedPool.ExtData memory e) {
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
        ShieldedPool.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = pay;
        t.fee = fee;
        t.token = address(usdc);
        t.recipient = pay == 0 ? address(0) : address(0xBEEF);
        ShieldedPool.ExtData memory e = _ext();
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
        ShieldedPool.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy-r", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = notes[i].amount;
        t.token = address(usdc);
        t.recipient = address(0xBAD);
        ShieldedPool.ExtData memory e = _ext();
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
    }

    /// Path B: reserve part of a note for an EIP-3009 transfer; change stays private.
    function authorize(uint256 seed, uint256 value) external {
        (bool ok, uint256 i) = _pickUnspent(seed);
        if (!ok || notes[i].amount == 0) return;
        GhostNote storage g = notes[i];
        value = bound(value, 1, g.amount);
        ShieldedPool.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [noteNullifier[i], uint256(keccak256(abi.encode("dummy-a", nonce++))) % 1e70];
        t.outCommitments = [nonce++, nonce++];
        t.publicAmount = value;
        t.token = address(usdc);
        t.recipient = address(0xC0FFEE);
        ShieldedPool.ExtData memory e = _ext();
        ShieldedPool.Authorization3009 memory a =
            ShieldedPool.Authorization3009(0, block.timestamp + 300, bytes32(nonce++));
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

    function invariant_noReplayEverSucceeds() public view {
        assertEq(handler.successfulReplays(), 0);
    }

    function invariant_currentRootAlwaysKnown_andTreeAligned() public view {
        assertTrue(pool.isKnownRoot(pool.root()));
        assertEq(pool.nextIndex() % 2, 0, "every insertion is a 2-leaf pair");
    }
}
