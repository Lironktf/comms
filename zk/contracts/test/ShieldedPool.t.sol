// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {ShieldedHashes} from "../src/libraries/ShieldedHashes.sol";
import {MerkleTree} from "../src/libraries/MerkleTree.sol";
import {FeeOnTransferToken, MockERC20} from "../src/mocks/MockERC20.sol";
import {PoolFixture} from "./helpers/PoolFixture.sol";

contract ShieldedPoolTest is PoolFixture {
    address alice = makeAddr("alice");

    function setUp() public {
        setUpPool();
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _tx(uint256 n0, uint256 n1, uint256 amount, uint256 fee, address recipient)
        internal
        view
        returns (ShieldedPool.TransactInputs memory t)
    {
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [n0, n1];
        t.outCommitments = [uint256(1001), uint256(1002)];
        t.publicAmount = amount;
        t.fee = fee;
        t.token = address(usdc);
        t.recipient = recipient;
    }

    function _declare(ShieldedPool.TransactInputs memory t, ShieldedPool.ExtData memory e, uint8 kind, bytes32 extra, bool deferred)
        internal
    {
        vTransact.declareTrue(transactPub(t, deferred, pool.computeContext(kind, e, extra)));
    }

    function _fund(uint256 amount) internal {
        deposit(alice, amount, 42);
    }

    // -----------------------------------------------------------------
    // deposit
    // -----------------------------------------------------------------

    function test_deposit_assignsUniqueLabels_andComputesCommitmentOnchain() public {
        (uint256 l1, uint256 c1, uint256 i1) = deposit(alice, 5e6, 42);
        (uint256 l2,, uint256 i2) = deposit(alice, 5e6, 42);
        assertTrue(l1 != l2 && l1 < FIELD && l2 < FIELD);
        assertEq(pool.depositorOf(l1), alice);
        assertEq(i1, 0);
        assertEq(i2, 2, "deposits insert (note, empty) pairs");
        assertEq(c1, ShieldedHashes.commitment(p2, 5e6, address(usdc), ShieldedHashes.noteCore(p2, l1, 42)));
        assertEq(usdc.balanceOf(address(pool)), 10e6);
        assertTrue(pool.isKnownRoot(pool.root()));
    }

    function test_deposit_rejects() public {
        usdc.mint(alice, 10e12);
        vm.startPrank(alice);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(ShieldedPool.ZeroAmount.selector);
        pool.deposit(address(usdc), 0, 1, "");
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositTooLarge.selector, 1_000_001e6, 1_000_000e6));
        pool.deposit(address(usdc), 1_000_001e6, 1, "");
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotField.selector, FIELD));
        pool.deposit(address(usdc), 1, FIELD, "");
        vm.expectRevert(ShieldedPool.EncryptedOutputTooLarge.selector);
        pool.deposit(address(usdc), 1, 1, new bytes(1025));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositsDisabled.selector, address(0xbeef)));
        pool.deposit(address(0xbeef), 1, 1, "");
        vm.stopPrank();
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        pool.configureToken(address(fot), true, false, 1e30);
        fot.mint(alice, 1e18);
        vm.startPrank(alice);
        fot.approve(address(pool), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.FeeOnTransferToken.selector, address(fot)));
        pool.deposit(address(fot), 1e18, 1, "");
        vm.stopPrank();
    }

    function test_onlyOwnerConfigures_andCannotTouchFunds() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.configureToken(address(usdc), false, false, 0);
        vm.prank(alice);
        vm.expectRevert();
        pool.setSwapAdapter(alice, true);
        // disabling deposits never strands existing notes: the token stays `known` (spendable)
        _fund(10e6);
        pool.configureToken(address(usdc), false, true, 0);
        (bool known, bool dep,,) = pool.tokenConfig(address(usdc));
        assertTrue(known && !dep);
    }

    // -----------------------------------------------------------------
    // transact
    // -----------------------------------------------------------------

    function test_transact_paysMerchantDirectly_andRelayerFee() public {
        _fund(10e6);
        ShieldedPool.TransactInputs memory t = _tx(11, 12, 5e6, 1e5, merchant);
        ShieldedPool.ExtData memory e = ext(relayer, bytes32(uint256(0xabc)));
        _declare(t, e, 1, 0, false);
        vm.prank(relayer);
        pool.transact("", t, e);
        assertEq(usdc.balanceOf(merchant), 5e6);
        assertEq(usdc.balanceOf(relayer), 1e5);
        assertTrue(pool.nullifierSpent(11) && pool.nullifierSpent(12));
        assertEq(pool.nextIndex(), 4);
    }

    function test_transact_replayRejected() public {
        _fund(10e6);
        ShieldedPool.TransactInputs memory t = _tx(11, 12, 5e6, 0, merchant);
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        _declare(t, e, 1, 0, false);
        pool.transact("", t, e);
        // the old root stays known, so a pure replay is caught by the nullifier set
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierSpent.selector, 11));
        pool.transact("", t, e);
    }

    function test_transact_rejectsBeforeProof() public {
        _fund(10e6);
        ShieldedPool.ExtData memory e = ext(relayer, 0);
        ShieldedPool.TransactInputs memory t;

        t = _tx(11, 11, 1, 0, merchant);
        vm.expectRevert(ShieldedPool.DuplicateNullifier.selector);
        pool.transact("", t, e);

        t = _tx(11, 12, 1, 0, merchant);
        t.root = 123;
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownRoot.selector, 123));
        pool.transact("", t, e);

        t = _tx(11, 12, 1, 0, merchant);
        t.aspRoot = 778;
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.InvalidAssociationRoot.selector, 778));
        pool.transact("", t, e);

        t = _tx(FIELD + 11, 12, 1, 0, merchant);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotField.selector, FIELD + 11));
        pool.transact("", t, e);

        t = _tx(11, 12, uint256(type(uint128).max) + 1, 0, merchant);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AmountTooLarge.selector, uint256(type(uint128).max) + 1));
        pool.transact("", t, e);

        t = _tx(11, 12, 1, 0, address(0));
        vm.expectRevert(ShieldedPool.BadRecipient.selector);
        pool.transact("", t, e);

        t = _tx(11, 12, 0, 0, merchant);
        vm.expectRevert(ShieldedPool.BadRecipient.selector);
        pool.transact("", t, e);

        t = _tx(11, 12, 1, 5, merchant);
        vm.expectRevert(ShieldedPool.BadFeeRecipient.selector);
        pool.transact("", t, ext(address(0), 0));

        t = _tx(11, 12, 1, 0, merchant);
        t.token = address(0xdead);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownToken.selector, address(0xdead)));
        pool.transact("", t, e);

        ShieldedPool.ExtData memory late = ext(relayer, 0);
        late.deadline = uint64(block.timestamp - 1);
        t = _tx(11, 12, 1, 0, merchant); // (computed first: _tx reads pool.root())
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.Expired.selector, late.deadline));
        pool.transact("", t, late);
    }

    function test_transact_undeclaredStatementIsInvalidProof() public {
        _fund(10e6);
        ShieldedPool.TransactInputs memory t = _tx(11, 12, 5e6, 0, merchant);
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        _declare(t, e, 1, 0, false);
        // same statement but a different ext -> different context -> no proof exists
        ShieldedPool.ExtData memory e2 = ext(address(0), bytes32(uint256(1)));
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transact("", t, e2);
        // a deferred-mode proof can't be used as a normal transact
        ShieldedPool.TransactInputs memory t3 = _tx(21, 22, 5e6, 0, merchant);
        _declare(t3, e, 1, 0, true);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transact("", t3, e);
    }

    function test_contextBindsChainAndPool() public {
        ShieldedPool.ExtData memory e = ext(relayer, bytes32(uint256(7)));
        uint256 c1 = pool.computeContext(1, e, 0);
        assertTrue(c1 < FIELD);
        assertTrue(c1 != pool.computeContext(2, e, 0), "kind");
        vm.chainId(8453);
        assertTrue(c1 != pool.computeContext(1, e, 0), "chain id");
    }

    function test_transactBatch_atomic_andOneTreeBatch() public {
        _fund(20e6);
        ShieldedPool.TransactCall[] memory calls = new ShieldedPool.TransactCall[](2);
        calls[0].inputs = _tx(11, 12, 1e6, 0, merchant);
        calls[0].ext = ext(address(0), bytes32(uint256(1)));
        calls[1].inputs = _tx(13, 14, 2e6, 0, makeAddr("merchant2"));
        calls[1].inputs.outCommitments = [uint256(2001), uint256(2002)];
        calls[1].ext = ext(address(0), bytes32(uint256(2)));
        _declare(calls[0].inputs, calls[0].ext, 1, 0, false);
        _declare(calls[1].inputs, calls[1].ext, 1, 0, false);
        pool.transactBatch(calls);
        assertEq(usdc.balanceOf(merchant), 1e6);
        assertEq(usdc.balanceOf(makeAddr("merchant2")), 2e6);
        assertEq(pool.nextIndex(), 6);
        // a batch containing one spent nullifier reverts entirely
        calls[0].inputs.root = pool.root();
        vm.expectRevert();
        pool.transactBatch(calls);
    }

    // -----------------------------------------------------------------
    // association set
    // -----------------------------------------------------------------

    function test_asp_latestRootPlusShortGrace() public {
        assertTrue(asp.isValidRoot(777));
        asp.publishRoot(888, "v2");
        assertTrue(asp.isValidRoot(888));
        assertTrue(asp.isValidRoot(777), "grace for in-flight proofs");
        vm.warp(block.timestamp + asp.GRACE());
        assertFalse(asp.isValidRoot(777), "excluded deposits stop moving after GRACE");
        assertFalse(asp.isValidRoot(0));
        vm.prank(alice);
        vm.expectRevert();
        asp.publishRoot(999, "x");
    }

    // -----------------------------------------------------------------
    // ragequit
    // -----------------------------------------------------------------

    function test_ragequit_paysOnlyTheDepositor() public {
        (uint256 label,,) = deposit(alice, 7e6, 42);
        uint256 root = pool.root();
        bytes32[] memory pub = new bytes32[](5);
        pub[0] = bytes32(root);
        pub[1] = bytes32(uint256(55));
        pub[2] = bytes32(uint256(7e6));
        pub[3] = bytes32(uint256(uint160(address(usdc))));
        pub[4] = bytes32(label);
        vRagequit.declareTrue(pub);
        vm.prank(relayer); // anyone can submit; only the depositor is paid
        pool.ragequit("", root, 55, 7e6, address(usdc), label);
        assertEq(usdc.balanceOf(alice), 7e6);
        assertEq(usdc.balanceOf(relayer), 0);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierSpent.selector, 55));
        pool.ragequit("", root, 55, 7e6, address(usdc), label);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotADeposit.selector, 1234));
        pool.ragequit("", root, 56, 7e6, address(usdc), 1234);
    }

    // -----------------------------------------------------------------
    // budget init
    // -----------------------------------------------------------------

    function test_initBudget_replayRejected() public {
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        uint64 ts = uint64(block.timestamp);
        bytes32[] memory pub = new bytes32[](3);
        pub[0] = bytes32(uint256(999));
        pub[1] = bytes32(uint256(ts));
        pub[2] = bytes32(pool.computeContext(3, e, 0));
        vBudget.declareTrue(pub);
        pool.initBudget("", 999, ts, e);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.BudgetAlreadyInitialized.selector, 999));
        pool.initBudget("", 999, ts, e);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.StaleTimestamp.selector, ts));
        pool.initBudget("", 1000, ts, e);
    }

    // -----------------------------------------------------------------
    // Path B: authorizeTransfer / isValidSignature / reclaim
    // -----------------------------------------------------------------

    function _authorize(bytes32 nonce, uint256 validBefore) internal returns (bytes32 digest, ShieldedPool.TransactInputs memory t) {
        t = _tx(uint256(nonce) % FIELD, uint256(nonce) % FIELD + 1, 3e6, 1e4, merchant);
        t.outCommitments = [uint256(5001), uint256(5002)];
        ShieldedPool.ExtData memory e = ext(relayer, 0);
        ShieldedPool.Authorization3009 memory a = ShieldedPool.Authorization3009(block.timestamp - 1, validBefore, nonce);
        _declare(t, e, 4, keccak256(abi.encode(a.validAfter, a.validBefore, a.nonce)), true);
        digest = pool.authorizeTransfer("", t, e, a);
    }

    function test_pathB_fullLifecycle_withFiatTokenSemantics() public {
        _fund(10e6);
        uint256 vb = block.timestamp + 300;
        (bytes32 digest,) = _authorize(bytes32(uint256(1)), vb);
        assertEq(pool.isValidSignature(digest, ""), bytes4(0x1626ba7e));
        assertEq(pool.isValidSignature(keccak256("anything else"), ""), bytes4(0xffffffff));
        assertEq(usdc.balanceOf(relayer), 1e4, "relayer fee paid at authorization");

        // a completely standard EIP-3009 transfer FROM the pool, executed by anyone (facilitator)
        vm.prank(makeAddr("facilitator"));
        usdc.transferWithAuthorization(address(pool), merchant, 3e6, block.timestamp - 1, vb, bytes32(uint256(1)), hex"677261797a6b");
        assertEq(usdc.balanceOf(merchant), 3e6);

        // can't be used twice (USDC nonce), can't be reclaimed after use
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(address(pool), merchant, 3e6, block.timestamp - 1, vb, bytes32(uint256(1)), hex"00");
        vm.warp(vb);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AuthorizationNotReclaimable.selector, digest));
        pool.reclaimAuthorization(digest);
    }

    function test_pathB_onlyTheExactAuthorizedTransferIsValid() public {
        _fund(10e6);
        uint256 vb = block.timestamp + 300;
        _authorize(bytes32(uint256(2)), vb);
        // different amount / recipient => different digest => pool does not vouch
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(pool), merchant, 3e6 + 1, block.timestamp - 1, vb, bytes32(uint256(2)), hex"00");
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(pool), relayer, 3e6, block.timestamp - 1, vb, bytes32(uint256(2)), hex"00");
    }

    function test_pathB_reclaimAfterExpiry_materializesRefundNote() public {
        _fund(10e6);
        uint256 vb = block.timestamp + 300;
        (bytes32 digest,) = _authorize(bytes32(uint256(3)), vb);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AuthorizationNotReclaimable.selector, digest));
        pool.reclaimAuthorization(digest);
        vm.warp(vb);
        uint256 before = pool.nextIndex();
        (uint256 cm,) = pool.reclaimAuthorization(digest);
        assertEq(cm, ShieldedHashes.commitment(p2, 3e6, address(usdc), 5002));
        assertEq(pool.nextIndex(), before + 2);
        assertEq(pool.isValidSignature(digest, ""), bytes4(0xffffffff));
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AuthorizationNotReclaimable.selector, digest));
        pool.reclaimAuthorization(digest);
        // and the expired authorization can't be executed either
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        usdc.transferWithAuthorization(address(pool), merchant, 3e6, 0, vb, bytes32(uint256(3)), hex"00");
    }

    function test_pathB_rejectsBadWindows_andNon3009Tokens() public {
        _fund(10e6);
        ShieldedPool.TransactInputs memory t = _tx(31, 32, 1e6, 0, merchant);
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        vm.expectRevert(ShieldedPool.BadAuthorizationWindow.selector);
        pool.authorizeTransfer("", t, e, ShieldedPool.Authorization3009(0, block.timestamp + 2 hours, bytes32(0)));
        vm.expectRevert(ShieldedPool.BadAuthorizationWindow.selector);
        pool.authorizeTransfer("", t, e, ShieldedPool.Authorization3009(0, block.timestamp, bytes32(0)));
        MockERC20 plain = new MockERC20("X", "X", 18);
        pool.configureToken(address(plain), true, false, 1e30);
        t.token = address(plain);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NotEip3009.selector, address(plain)));
        pool.authorizeTransfer("", t, e, ShieldedPool.Authorization3009(0, block.timestamp + 60, bytes32(0)));
    }

    // -----------------------------------------------------------------
    // policy pay: pre-proof checks
    // -----------------------------------------------------------------

    function test_policyPay_rejectsUnknownVendorRoot_staleTime_inactiveVendor() public {
        _fund(10e6);
        ShieldedPool.PolicyInputs memory p;
        p.root = pool.root();
        p.aspRoot = 777;
        p.vendorRoot = 4242;
        p.vendorChecked = true;
        p.nullifiers = [uint256(1), uint256(2)];
        p.budgetNullifier = 3;
        p.amount = 1e6;
        p.token = address(usdc);
        p.recipient = merchant;
        p.timestamp = uint64(block.timestamp);
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.UnknownVendorRoot.selector, 4242));
        pool.payWithPolicy("", p, e);
        p.vendorRoot = vendorTree.root();
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.VendorNotActive.selector, merchant));
        pool.payWithPolicy("", p, e);
        p.timestamp = uint64(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.StaleTimestamp.selector, p.timestamp));
        pool.payWithPolicy("", p, e);
        p.timestamp = uint64(block.timestamp);
        string[] memory none = new string[](0);
        address[] memory w = new address[](1);
        w[0] = merchant;
        vm.prank(merchant);
        vendors.registerVendor("merchant.example", none, w, "", bytes32(0), "");
        p.budgetNullifier = 2;
        vm.expectRevert(ShieldedPool.DuplicateNullifier.selector);
        pool.payWithPolicy("", p, e);
    }

    function test_rootHistoryIsBounded() public {
        _fund(1e6);
        uint256 old = pool.root();
        for (uint256 i; i < MerkleTree.ROOT_HISTORY; ++i) deposit(alice, 1, i + 100);
        assertFalse(pool.isKnownRoot(old));
    }
}
