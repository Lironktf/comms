// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHonkVerifier} from "./interfaces/IHonkVerifier.sol";
import {IAssociationSet} from "./interfaces/IAssociationSet.sol";
import {IVendorTree} from "./interfaces/IVendorTree.sol";
import {IPoseidon2} from "./interfaces/IPoseidon2.sol";
import {MerkleTree} from "./libraries/MerkleTree.sol";
import {ShieldedHashes} from "./libraries/ShieldedHashes.sol";
import {PaymentBook} from "./PaymentBook.sol";
import {ShieldedPoolCore} from "./ShieldedPoolCore.sol";

/// @title AggregationModule — settle 2, 4 or 8 transact payments with ONE recursive proof.
/// @notice Runs only through ShieldedPool's fallback (DELEGATECALL), so it reads and writes the
///         pool's storage and holds no funds. The pool creates it in its own constructor with its
///         own wiring, so the owner can't swap it. ShieldedPoolCore keeps the storage layout and
///         the checks identical to `transact` / `pay` / `batch`, which stay available as the
///         censorship escape hatch: anyone can still settle their own proof directly.
///
///         The proof is the root of the aggregation tree (circuits/agg, docs/aggregation.md).
///         Its one public input is a digest of every payment's 12 transact public inputs, which
///         this contract recomputes from calldata, so changing, dropping or reordering any
///         payment, or any of its fields, after proving makes verification fail.
contract AggregationModule is ShieldedPoolCore {
    using SafeERC20 for IERC20;
    using MerkleTree for MerkleTree.Tree;

    /// One payment of an aggregate. `deferred` selects the statement the inner proof made:
    ///   false  a `transact` (direct payment, withdrawal or private transfer); `opts` is unused
    ///   true   a `pay` (REFUNDABLE or ESCROW, deferred mode), bound to `opts` through context
    struct AggPayment {
        TransactInputs inputs;
        ExtData ext;
        bool deferred;
        PayOptions opts;
    }

    /// Verifier of the tree root for 2, 4 and 8 payments (each size is its own circuit).
    IHonkVerifier public immutable aggregate2Verifier;
    IHonkVerifier public immutable aggregate4Verifier;
    IHonkVerifier public immutable aggregate8Verifier;
    address private immutable _self;

    error BadAggregateSize(uint256 n);
    error NotDelegated();

    /// Pool-side wiring must equal the pool's (the pool passes its own). The policy, budget and
    /// ragequit verifiers are left unset: this module never verifies those statements.
    constructor(
        IHonkVerifier transactVerifier_,
        IAssociationSet associationSet_,
        IVendorTree vendorTree_,
        IPoseidon2 poseidon2_,
        PaymentBook paymentBook_,
        IHonkVerifier[3] memory aggregateVerifiers_
    )
        ShieldedPoolCore(
            transactVerifier_, IHonkVerifier(address(0)), IHonkVerifier(address(0)), IHonkVerifier(address(0)),
            associationSet_, vendorTree_, poseidon2_, paymentBook_, msg.sender
        )
    {
        aggregate2Verifier = aggregateVerifiers_[0];
        aggregate4Verifier = aggregateVerifiers_[1];
        aggregate8Verifier = aggregateVerifiers_[2];
        _self = address(this);
    }

    /// @notice Settle `payments` (2, 4 or 8) with one aggregate proof. Per payment it runs the
    ///         same checks and effects as `transact` (or `pay` when deferred): known root, valid
    ///         association-set root, unspent and distinct nullifiers (also across the batch),
    ///         deadline, fee recipient, mode and refund/escrow record. Then one verification,
    ///         one tree insertion, and one transfer per distinct (token, recipient), with a
    ///         PublicPayment event per payment so merchants can reconcile by requestId.
    function settleAggregated(bytes calldata proof, AggPayment[] calldata payments) external nonReentrant {
        if (address(this) == _self) revert NotDelegated();
        uint256 n = payments.length;
        if (n == 0) revert EmptyBatch();
        IHonkVerifier verifier =
            n == 2 ? aggregate2Verifier : n == 4 ? aggregate4Verifier : n == 8 ? aggregate8Verifier : IHonkVerifier(address(0));
        if (address(verifier) == address(0)) revert BadAggregateSize(n);

        // checks + nullifiers, and the digest tree's leaves: K(pi_2k || pi_2k+1)
        uint256[] memory leaves = new uint256[](2 * n);
        uint256[] memory level = new uint256[](n / 2);
        bytes32[] memory left;
        for (uint256 i; i < n; ++i) {
            AggPayment calldata p = payments[i];
            uint256 context = p.deferred ? _payContext(p.inputs, p.ext, p.opts) : _context(KIND_TRANSACT, p.ext, bytes32(0));
            bytes32[] memory pub = _transactPub(p.inputs, p.ext, p.deferred, context);
            // marked before the next payment's check, so a nullifier reused within the batch
            // reverts with NullifierSpent; all of it reverts if the proof is rejected below
            _spend(p.inputs.nullifiers);
            leaves[2 * i] = p.inputs.outCommitments[0];
            // a deferred out1 is the refund core, inserted only if a refund happens (as in `pay`)
            if (!p.deferred) leaves[2 * i + 1] = p.inputs.outCommitments[1];
            if (i % 2 == 0) left = pub;
            else level[i / 2] = ShieldedHashes.toField(keccak256(abi.encodePacked(left, pub)));
        }
        // levels above: K(d_left || d_right), up to the root
        for (uint256 w = n / 2; w > 1; w /= 2) {
            for (uint256 i; i < w; i += 2) {
                level[i / 2] = ShieldedHashes.toField(keccak256(abi.encodePacked(level[i], level[i + 1])));
            }
        }
        bytes32[] memory pubAgg = new bytes32[](1);
        pubAgg[0] = bytes32(level[0]);
        _verify(verifier, proof, pubAgg);

        uint256 start = _tree.insert(poseidon2, leaves);
        for (uint256 i; i < n; ++i) {
            emit NewCommitment(leaves[2 * i], start + 2 * i, payments[i].ext.encryptedOutput0);
            if (!payments[i].deferred) emit NewCommitment(leaves[2 * i + 1], start + 2 * i + 1, payments[i].ext.encryptedOutput1);
        }

        // interactions last: refund/escrow records, then netted transfers
        address[] memory tokens = new address[](2 * n);
        address[] memory tos = new address[](2 * n);
        uint256[] memory amounts = new uint256[](2 * n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            AggPayment calldata p = payments[i];
            TransactInputs calldata t = p.inputs;
            bool escrow;
            if (p.deferred) {
                _openPayment(t.nullifiers[0], t.token, t.recipient, t.publicAmount, t.outCommitments[1], false, p.ext, p.opts);
                escrow = p.opts.mode == MODE_ESCROW;
            }
            if (t.publicAmount != 0) {
                // escrowed funds wait in the book, which announces them (PaymentRecorded);
                // everything else gets the same event as _payout
                m = _add(tokens, tos, amounts, m, t.token, escrow ? address(paymentBook) : t.recipient, t.publicAmount);
                if (!escrow) emit PublicPayment(p.ext.requestId, t.recipient, t.token, t.publicAmount, t.fee, p.ext.feeRecipient);
            }
            if (t.fee != 0) m = _add(tokens, tos, amounts, m, t.token, p.ext.feeRecipient, t.fee);
        }
        for (uint256 k; k < m; ++k) {
            IERC20(tokens[k]).safeTransfer(tos[k], amounts[k]);
        }
    }

    /// Adds `amount` to the (token, to) entry, creating it if new; returns the entry count.
    function _add(
        address[] memory tokens,
        address[] memory tos,
        uint256[] memory amounts,
        uint256 m,
        address token,
        address to,
        uint256 amount
    ) private pure returns (uint256) {
        for (uint256 k; k < m; ++k) {
            if (tokens[k] == token && tos[k] == to) {
                amounts[k] += amount;
                return m;
            }
        }
        tokens[m] = token;
        tos[m] = to;
        amounts[m] = amount;
        return m + 1;
    }
}
