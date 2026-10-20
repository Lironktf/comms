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
import {AggregationModule} from "./AggregationModule.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title ShieldedPool — private agent payments on Base.
/// @notice One vault holding everyone's tokens plus a Merkle tree of note commitments.
///         No balances are stored per user. Spending = a zero-knowledge proof of owning
///         an unspent note; the pool pays the merchant DIRECTLY in the same transaction.
///         The public sees "the pool paid M $X", never who paid.
///
///         Entry points:
///           deposit             public: tokens in, commitment inserted, label assigned
///           transact            private transfer / pay a merchant / withdraw (2-in-2-out)
///           pay                 refundable or escrowed payment (transact proof, deferred mode)
///           payWithPolicy       agent payment with spending policy enforced in-proof
///                               (direct, refundable or escrowed)
///           batch               any mix of the above in ONE transaction and ONE tree insertion
///           initBudget          policy admin mints an agent's budget note
///           ragequit            public exit to the original depositor (compliance)
///           authorizeTransfer   Path B: approve one EIP-3009 transfer FROM the pool (EIP-1271)
///           reclaimAuthorization refund an expired, unused Path-B authorization as a note
///           swap                private swap through an allowlisted adapter (Railgun-style)
///           (PaymentBook)       refunds and the escrow lifecycle (see docs/refunds-escrow.md);
///                               refund notes come back through shieldRefund
///
///         Ordering in every spend (checks-effects-interactions): validate public inputs and
///         roots -> verify proof -> record nullifiers -> insert commitments -> external transfers.
///
///         The owner can ONLY configure tokens (enable deposits, caps) and allowlist swap
///         adapters. It cannot move, freeze or redirect funds, and cannot pause spends or
///         ragequit. The contract is not upgradeable.
contract ShieldedPool is ShieldedPoolCore {
    using SafeERC20 for IERC20;
    using MerkleTree for MerkleTree.Tree;

    /// Runs `settleAggregated` (recursive aggregation, docs/aggregation.md) with this pool's
    /// storage. Created by this constructor with this pool's own wiring; it cannot be changed.
    address public immutable aggregationModule;

    constructor(
        IHonkVerifier transactVerifier_,
        IHonkVerifier policyPayVerifier_,
        IHonkVerifier budgetInitVerifier_,
        IHonkVerifier ragequitVerifier_,
        IAssociationSet associationSet_,
        IVendorTree vendorTree_,
        IPoseidon2 poseidon2_,
        address owner_,
        IHonkVerifier[3] memory aggregateVerifiers_
    )
        ShieldedPoolCore(
            transactVerifier_, policyPayVerifier_, budgetInitVerifier_, ragequitVerifier_, associationSet_, vendorTree_,
            poseidon2_, new PaymentBook(vendorTree_), owner_
        )
    {
        _tree.init();
        aggregationModule = address(
            new AggregationModule(
                transactVerifier_, associationSet_, vendorTree_, poseidon2_, paymentBook, aggregateVerifiers_
            )
        );
    }

    // ------------------------------------------------------------------
    // Admin (configuration only)
    // ------------------------------------------------------------------

    /// @notice Allowlist a token. Only plain ERC-20s: no fee-on-transfer (also rejected at
    ///         deposit by a balance-delta check), no rebasing (would break note accounting).
    ///         A token, once known, stays spendable forever; only new deposits can be disabled.
    function configureToken(address token, bool depositsEnabled, bool eip3009, uint128 maxDeposit)
        external
        onlyOwner
    {
        if (token == address(0)) revert UnknownToken(token);
        tokenConfig[token] = TokenConfig({
            known: true, depositsEnabled: depositsEnabled, eip3009: eip3009, maxDeposit: maxDeposit
        });
        emit TokenConfigured(token, depositsEnabled, eip3009, maxDeposit);
    }

    function setSwapAdapter(address adapter, bool allowed) external onlyOwner {
        swapAdapterAllowed[adapter] = allowed;
        emit SwapAdapterSet(adapter, allowed);
    }

    // ------------------------------------------------------------------
    // Deposit
    // ------------------------------------------------------------------

    /// @notice Deposit `amount` of `token` as a new note. `inner` = H3(owner, blinding, policy)
    ///         is computed client-side, so the chain never sees owner, blinding or policy.
    ///         Depositor, token and amount are public. The deposit gets a fresh `label`
    ///         (its lineage tag for association sets and ragequit), and the contract computes
    ///         the commitment itself, so a deposit can't create a note worth more than it paid.
    function deposit(address token, uint256 amount, uint256 inner, bytes calldata encryptedNote)
        external
        nonReentrant
        returns (uint256 label, uint256 commitment, uint256 leafIndex)
    {
        TokenConfig memory cfg = tokenConfig[token];
        if (!cfg.depositsEnabled) revert DepositsDisabled(token);
        if (amount == 0) revert ZeroAmount();
        if (amount > cfg.maxDeposit) revert DepositTooLarge(amount, cfg.maxDeposit);
        _checkField(inner);
        if (encryptedNote.length > MAX_ENCRYPTED_OUTPUT) revert EncryptedOutputTooLarge();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken(token);

        label = ShieldedHashes.toField(keccak256(abi.encode(LABEL_DOMAIN, block.chainid, address(this), depositCount++)));
        depositorOf[label] = msg.sender;
        commitment = ShieldedHashes.commitment(poseidon2, amount, token, ShieldedHashes.noteCore(poseidon2, label, inner));

        // Insert as a pair (note, empty) so every insertion stays aligned to 2-leaf subtrees.
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = commitment;
        leafIndex = _tree.insert(poseidon2, leaves);

        emit NewCommitment(commitment, leafIndex, encryptedNote);
        emit Deposited(label, msg.sender, token, amount, commitment, leafIndex);
    }

    // ------------------------------------------------------------------
    // Spends: transact (private transfer / pay / withdraw)
    // ------------------------------------------------------------------

    /// @notice Pay a merchant, withdraw, or transfer privately. To pay merchant M for an x402
    ///         request, the proof's recipient = M, publicAmount = price, ext.requestId = the
    ///         x402 request id. The merchant receives `publicAmount` of `token` in this tx.
    function transact(bytes calldata proof, TransactInputs calldata inputs, ExtData calldata ext)
        external
        nonReentrant
    {
        uint256[] memory leaves = new uint256[](2);
        _verifyTransact(proof, inputs, ext, false, _context(KIND_TRANSACT, ext, bytes32(0)));
        leaves[0] = inputs.outCommitments[0];
        leaves[1] = inputs.outCommitments[1];
        uint256 start = _tree.insert(poseidon2, leaves);
        _emitOutputs(start, leaves, ext);
        _payout(inputs.token, inputs.recipient, inputs.publicAmount, inputs.fee, ext);
    }

    /// @notice Refundable or escrowed payment from plain notes: a `transact` proof in DEFERRED
    ///         mode whose out1 is the payer's refund-note core (never inserted unless refunded).
    ///         REFUNDABLE pays the merchant now; ESCROW keeps `publicAmount` in the pool.
    function pay(bytes calldata proof, TransactInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts)
        external
        nonReentrant
    {
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = _verifyPay(proof, inputs, ext, opts);
        uint256 start = _tree.insert(poseidon2, leaves);
        emit NewCommitment(leaves[0], start, ext.encryptedOutput0);
        _settlePay(inputs.nullifiers[0], inputs.token, inputs.recipient, inputs.publicAmount, inputs.fee, inputs.outCommitments[1], false, ext, opts);
    }

    function payWithPolicy(bytes calldata proof, PolicyInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts)
        external
        nonReentrant
    {
        _verifyPolicy(proof, inputs, ext, opts);
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = inputs.changeCommitment;
        leaves[1] = inputs.newBudgetCommitment;
        uint256 start = _tree.insert(poseidon2, leaves);
        _emitOutputs(start, leaves, ext);
        _settlePolicy(inputs, ext, opts);
    }

    /// @notice Submit any mix of transact, pay and policy proofs in ONE transaction
    ///         (relayers/facilitators). All must be valid (atomic). Saves the per-tx base cost
    ///         and inserts every output as ONE tree batch; payments may go to different merchants,
    ///         which also blurs timing (several payers, one transaction).
    function batch(TransactCall[] calldata transacts, PayCall[] calldata pays, PolicyCall[] calldata policyPays)
        external
        nonReentrant
    {
        uint256 nt = transacts.length;
        uint256 np = pays.length;
        uint256 nq = policyPays.length;
        if (nt + np + nq == 0) revert EmptyBatch();
        // leaf layout: [transact pairs][pay change, 0][policy change, budget]
        uint256[] memory leaves = new uint256[](2 * (nt + np + nq));
        for (uint256 i; i < nt; ++i) {
            TransactCall calldata c = transacts[i];
            _verifyTransact(c.proof, c.inputs, c.ext, false, _context(KIND_TRANSACT, c.ext, bytes32(0)));
            leaves[2 * i] = c.inputs.outCommitments[0];
            leaves[2 * i + 1] = c.inputs.outCommitments[1];
        }
        for (uint256 i; i < np; ++i) {
            PayCall calldata c = pays[i];
            leaves[2 * (nt + i)] = _verifyPay(c.proof, c.inputs, c.ext, c.opts);
        }
        for (uint256 i; i < nq; ++i) {
            PolicyCall calldata c = policyPays[i];
            _verifyPolicy(c.proof, c.inputs, c.ext, c.opts);
            leaves[2 * (nt + np + i)] = c.inputs.changeCommitment;
            leaves[2 * (nt + np + i) + 1] = c.inputs.newBudgetCommitment;
        }
        uint256 start = _tree.insert(poseidon2, leaves);
        for (uint256 i; i < nt; ++i) {
            emit NewCommitment(leaves[2 * i], start + 2 * i, transacts[i].ext.encryptedOutput0);
            emit NewCommitment(leaves[2 * i + 1], start + 2 * i + 1, transacts[i].ext.encryptedOutput1);
        }
        for (uint256 i; i < np; ++i) {
            emit NewCommitment(leaves[2 * (nt + i)], start + 2 * (nt + i), pays[i].ext.encryptedOutput0);
        }
        for (uint256 i; i < nq; ++i) {
            uint256 k = 2 * (nt + np + i);
            emit NewCommitment(leaves[k], start + k, policyPays[i].ext.encryptedOutput0);
            emit NewCommitment(leaves[k + 1], start + k + 1, policyPays[i].ext.encryptedOutput1);
        }
        // interactions last
        for (uint256 i; i < nt; ++i) {
            TransactCall calldata c = transacts[i];
            _payout(c.inputs.token, c.inputs.recipient, c.inputs.publicAmount, c.inputs.fee, c.ext);
        }
        for (uint256 i; i < np; ++i) {
            PayCall calldata c = pays[i];
            _settlePay(c.inputs.nullifiers[0], c.inputs.token, c.inputs.recipient, c.inputs.publicAmount, c.inputs.fee, c.inputs.outCommitments[1], false, c.ext, c.opts);
        }
        for (uint256 i; i < nq; ++i) {
            _settlePolicy(policyPays[i].inputs, policyPays[i].ext, policyPays[i].opts);
        }
    }

    /// @notice The policy admin creates an agent's budget note (see circuits/budget_init).
    function initBudget(bytes calldata proof, uint256 budgetCommitment, uint64 timestamp, ExtData calldata ext)
        external
        nonReentrant
    {
        _checkField(budgetCommitment);
        _checkTimestamp(timestamp);
        _checkExt(ext);
        if (budgetInitialized[budgetCommitment]) revert BudgetAlreadyInitialized(budgetCommitment);

        bytes32[] memory pub = new bytes32[](3);
        pub[0] = bytes32(budgetCommitment);
        pub[1] = bytes32(uint256(timestamp));
        pub[2] = bytes32(_context(KIND_BUDGET_INIT, ext, bytes32(0)));
        _verify(budgetInitVerifier, proof, pub);

        budgetInitialized[budgetCommitment] = true;
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = budgetCommitment;
        uint256 start = _tree.insert(poseidon2, leaves);
        emit NewCommitment(budgetCommitment, start, ext.encryptedOutput0);
    }

    // ------------------------------------------------------------------
    // Compliance: ragequit
    // ------------------------------------------------------------------

    /// @notice Public exit of one note back to the address that made the deposit with this
    ///         label. Reveals amount/token/label. Works even if the label is excluded from the
    ///         association set: honest users are never trapped, and funds never go anywhere
    ///         except where they came from. Anyone may submit; only the depositor gets paid.
    function ragequit(bytes calldata proof, uint256 root, uint256 nullifier_, uint256 amount, address token, uint256 label)
        external
        nonReentrant
    {
        address depositor = depositorOf[label];
        if (depositor == address(0)) revert NotADeposit(label);
        if (!tokenConfig[token].known) revert UnknownToken(token);
        if (amount == 0) revert ZeroAmount();
        if (amount > MAX_AMOUNT) revert AmountTooLarge(amount);
        _checkField(nullifier_);
        if (!_tree.isKnownRoot(root)) revert UnknownRoot(root);
        if (nullifierSpent[nullifier_]) revert NullifierSpent(nullifier_);

        bytes32[] memory pub = new bytes32[](5);
        pub[0] = bytes32(root);
        pub[1] = bytes32(nullifier_);
        pub[2] = bytes32(amount);
        pub[3] = bytes32(uint256(uint160(token)));
        pub[4] = bytes32(label);
        _verify(ragequitVerifier, proof, pub);

        nullifierSpent[nullifier_] = true;
        emit NewNullifier(nullifier_);
        emit Ragequit(label, depositor, token, amount);
        IERC20(token).safeTransfer(depositor, amount);
    }

    // ------------------------------------------------------------------
    // Path B: the pool as a standard x402 `exact` payer (EIP-3009 + EIP-1271)
    // ------------------------------------------------------------------

    /// @notice Spend notes into ONE pre-approved EIP-3009 transfer from the pool to `to`.
    ///         The merchant then receives a completely normal x402 `exact` payment with
    ///         from = pool; its unmodified facilitator calls USDC.transferWithAuthorization,
    ///         and USDC asks the pool (EIP-1271 isValidSignature) whether it signed. The pool
    ///         answers yes for exactly this digest, until validBefore.
    ///
    ///         The proof is a `transact` proof in DEFERRED mode: out1 is the core of a refund
    ///         note worth exactly `publicAmount`, materialized only via reclaimAuthorization
    ///         if the authorization expires unused.
    function authorizeTransfer(
        bytes calldata proof,
        TransactInputs calldata inputs,
        ExtData calldata ext,
        Authorization3009 calldata auth
    ) external nonReentrant returns (bytes32 digest) {
        if (!tokenConfig[inputs.token].eip3009) revert NotEip3009(inputs.token);
        if (inputs.publicAmount == 0) revert ZeroAmount();
        if (
            auth.validBefore <= block.timestamp || auth.validBefore > block.timestamp + MAX_AUTH_WINDOW
                || auth.validAfter >= auth.validBefore
        ) revert BadAuthorizationWindow();

        bytes32 extra = keccak256(abi.encode(auth.validAfter, auth.validBefore, auth.nonce));
        _verifyTransact(proof, inputs, ext, true, _context(KIND_AUTHORIZE, ext, extra));

        digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC3009(inputs.token).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                        address(this),
                        inputs.recipient,
                        inputs.publicAmount,
                        auth.validAfter,
                        auth.validBefore,
                        auth.nonce
                    )
                )
            )
        );
        if (pendingAuthorizations[digest].validBefore != 0) revert AuthorizationExists(digest);
        if (IERC3009(inputs.token).authorizationState(address(this), auth.nonce)) revert AuthorizationExists(digest);
        pendingAuthorizations[digest] = PendingAuthorization({
            token: inputs.token,
            validBefore: uint64(auth.validBefore),
            closed: false,
            nonce: auth.nonce,
            value: inputs.publicAmount,
            refundCore: inputs.outCommitments[1]
        });

        uint256[] memory leaves = new uint256[](2);
        leaves[0] = inputs.outCommitments[0];
        uint256 start = _tree.insert(poseidon2, leaves);
        emit NewCommitment(leaves[0], start, ext.encryptedOutput0);
        emit TransferAuthorized(
            digest,
            inputs.recipient,
            inputs.token,
            inputs.publicAmount,
            auth.validBefore,
            auth.nonce,
            inputs.outCommitments[1],
            ext.encryptedOutput1
        );
        // Only the relayer fee moves now; the payment itself moves when the merchant settles.
        _payout(inputs.token, address(0), 0, inputs.fee, ext);
    }

    /// @notice After an authorization's validBefore, if USDC never executed it, turn the
    ///         reserved amount back into a private note (the refund core committed in the proof).
    ///         Anyone may call. USDC requires block.timestamp < validBefore to execute and this
    ///         requires >= validBefore, so execution and refund are mutually exclusive.
    function reclaimAuthorization(bytes32 digest) external nonReentrant returns (uint256 commitment, uint256 leafIndex) {
        PendingAuthorization storage a = pendingAuthorizations[digest];
        if (a.validBefore == 0 || a.closed || block.timestamp < a.validBefore) {
            revert AuthorizationNotReclaimable(digest);
        }
        if (IERC3009(a.token).authorizationState(address(this), a.nonce)) revert AuthorizationNotReclaimable(digest);
        a.closed = true;
        commitment = ShieldedHashes.commitment(poseidon2, a.value, a.token, a.refundCore);
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = commitment;
        leafIndex = _tree.insert(poseidon2, leaves);
        emit NewCommitment(commitment, leafIndex, "");
        emit AuthorizationReclaimed(digest, commitment, leafIndex);
    }

    /// @notice EIP-1271. Valid ONLY for digests this contract computed itself in
    ///         authorizeTransfer (TransferWithAuthorization structs from the pool), while open
    ///         and before validBefore. The signature bytes are ignored. Clients must send a
    ///         non-65-byte signature so facilitators route to USDC's `bytes` overload.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        PendingAuthorization storage a = pendingAuthorizations[hash];
        if (a.validBefore != 0 && !a.closed && block.timestamp < a.validBefore) return EIP1271_MAGIC;
        return 0xffffffff;
    }

    // ------------------------------------------------------------------
    // Private swaps (Railgun-style relay adapter)
    // ------------------------------------------------------------------

    /// @notice Atomically: spend notes of token A -> swap `publicAmount` through an allowlisted
    ///         adapter -> re-shield the output as a new note of token B for the same owner and
    ///         deposit label (out1 is a deferred core). Public: the swap (A, B, amounts), never who.
    function swap(bytes calldata proof, TransactInputs calldata inputs, ExtData calldata ext, SwapParams calldata sp)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (!swapAdapterAllowed[sp.adapter]) revert AdapterNotAllowed(sp.adapter);
        if (!tokenConfig[sp.tokenOut].known) revert UnknownToken(sp.tokenOut);
        if (sp.tokenOut == inputs.token) revert SameToken();
        if (inputs.recipient != sp.adapter) revert BadRecipient();
        if (inputs.publicAmount == 0) revert ZeroAmount();

        bytes32 extra = keccak256(abi.encode(sp.adapter, sp.tokenOut, sp.minAmountOut, keccak256(sp.data)));
        _verifyTransact(proof, inputs, ext, true, _context(KIND_SWAP, ext, extra));

        // Interaction with the allowlisted adapter happens after nullifiers are recorded; the
        // output note is inserted only after measuring what the pool actually received.
        uint256 before = IERC20(sp.tokenOut).balanceOf(address(this));
        IERC20(inputs.token).safeTransfer(sp.adapter, inputs.publicAmount);
        ISwapAdapter(sp.adapter).swap(inputs.token, sp.tokenOut, inputs.publicAmount, sp.minAmountOut, sp.data, address(this));
        amountOut = IERC20(sp.tokenOut).balanceOf(address(this)) - before;
        if (amountOut < sp.minAmountOut || amountOut == 0) revert SlippageExceeded(amountOut, sp.minAmountOut);
        if (amountOut > MAX_AMOUNT) revert AmountTooLarge(amountOut);

        uint256[] memory leaves = new uint256[](2);
        leaves[0] = inputs.outCommitments[0];
        leaves[1] = ShieldedHashes.commitment(poseidon2, amountOut, sp.tokenOut, inputs.outCommitments[1]);
        uint256 start = _tree.insert(poseidon2, leaves);
        _emitOutputs(start, leaves, ext);
        emit Swapped(sp.adapter, inputs.token, sp.tokenOut, inputs.publicAmount, amountOut, start + 1);
        _payout(inputs.token, address(0), 0, inputs.fee, ext);
    }

    // ------------------------------------------------------------------
    // Refund notes (called by this pool's PaymentBook)
    // ------------------------------------------------------------------

    /// @notice Turn `amount` of `token`, already transferred to the pool by the PaymentBook, into
    ///         the payer's refund note H3(amount, token, refundCore). Only the book this pool
    ///         deployed can call it; the book only does so for refund cores bound in a proof.
    function shieldRefund(uint256 id, address token, uint256 amount, uint256 refundCore)
        external
        nonReentrant
        returns (uint256 commitment, uint256 leafIndex)
    {
        if (msg.sender != address(paymentBook)) revert NotPaymentBook();
        commitment = ShieldedHashes.commitment(poseidon2, amount, token, refundCore);
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = commitment;
        leafIndex = _tree.insert(poseidon2, leaves);
        emit NewCommitment(commitment, leafIndex, "");
        emit Refunded(id, amount, commitment, leafIndex);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function root() external view returns (uint256) {
        return _tree.root;
    }

    function nextIndex() external view returns (uint256) {
        return _tree.nextIndex;
    }

    function isKnownRoot(uint256 r) external view returns (bool) {
        return _tree.isKnownRoot(r);
    }

    /// @notice The `context` public input a proof must carry for (kind, ext, extra). Exposed so
    ///         clients and tests compute it with the contract's exact encoding.
    function computeContext(uint8 kind, ExtData calldata ext, bytes32 extra) external view returns (uint256) {
        return _context(kind, ext, extra);
    }

    /// Selectors this contract doesn't define (only `settleAggregated` and the module's
    /// verifier getters) run in the aggregation module, against this pool's storage.
    fallback() external {
        address m = aggregationModule;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
