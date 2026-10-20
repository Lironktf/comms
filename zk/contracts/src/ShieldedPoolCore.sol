// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IHonkVerifier} from "./interfaces/IHonkVerifier.sol";
import {IAssociationSet} from "./interfaces/IAssociationSet.sol";
import {IVendorTree} from "./interfaces/IVendorTree.sol";
import {IPoseidon2} from "./interfaces/IPoseidon2.sol";
import {MerkleTree} from "./libraries/MerkleTree.sol";
import {ShieldedHashes} from "./libraries/ShieldedHashes.sol";
import {PaymentBook, PaymentRecord} from "./PaymentBook.sol";

/// @title ShieldedPoolCore — the pool's types, storage, events, errors and spend checks.
/// @notice Shared by ShieldedPool (the entry points) and AggregationModule (settleAggregated),
///         which the pool runs with DELEGATECALL, so both must see exactly the same storage
///         layout and the same checks. Nothing here is externally callable on its own except
///         the public getters. See ShieldedPool for the protocol description.
abstract contract ShieldedPoolCore is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using MerkleTree for MerkleTree.Tree;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct TransactInputs {
        uint256 root;
        uint256 aspRoot;
        uint256[2] nullifiers;
        uint256[2] outCommitments;
        uint256 publicAmount;
        uint256 fee;
        address token;
        address recipient;
    }

    struct PolicyInputs {
        uint256 root;
        uint256 aspRoot;
        uint256 vendorRoot;
        /// public bit = the policy's private `require_verified_vendor` flag (proven equal)
        bool vendorChecked;
        uint256[2] nullifiers;
        uint256 budgetNullifier;
        uint256 changeCommitment;
        uint256 newBudgetCommitment;
        /// core of the agent's refund note (same owner, policy, label; circuit-constrained)
        uint256 refundCore;
        uint256 amount;
        uint256 fee;
        address token;
        address recipient;
        uint64 timestamp;
    }

    /// Data bound into the proof through `context` but not used by circuit logic.
    struct ExtData {
        address feeRecipient;
        bytes32 requestId; // x402 request id / nonce (0 if not an x402 payment)
        uint64 deadline;
        bytes encryptedOutput0;
        bytes encryptedOutput1;
    }

    struct TransactCall {
        bytes proof;
        TransactInputs inputs;
        ExtData ext;
    }

    /// How a payment settles. Bound into the proof through `context` (extra = keccak(opts)),
    /// so a relayer can't turn an escrow into a direct payment or swap the refund ciphertext.
    ///   DIRECT      merchant paid now, no refund slot (payWithPolicy only; plain = transact)
    ///   REFUNDABLE  merchant paid now; it may later refund up to `amount` into the payer's
    ///               refund note without ever learning who the payer is
    ///   ESCROW      pool holds the funds; see the escrow functions
    struct PayOptions {
        uint8 mode;
        address arbiter; // escrow: may resolve disputes (0 = no disputes possible)
        uint64 claimableAt; // escrow: merchant may claim from here; payer may dispute before
        uint64 expiresAt; // escrow: unclaimed/unresolved escrow refunds to the payer from here
        /// escrow: keccak256(abi.encode(keccak256(releaseSecret), keccak256(disputeSecret)))
        bytes32 payerAuth;
        bytes encryptedRefund; // ciphertext of the refund note (amount/token come from events)
    }

    struct PolicyCall {
        bytes proof;
        PolicyInputs inputs;
        ExtData ext;
        PayOptions opts;
    }

    struct PayCall {
        bytes proof;
        TransactInputs inputs;
        ExtData ext;
        PayOptions opts;
    }

    struct Authorization3009 {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    struct PendingAuthorization {
        address token;
        uint64 validBefore;
        bool closed;
        bytes32 nonce;
        uint256 value;
        uint256 refundCore;
    }

    struct SwapParams {
        address adapter;
        address tokenOut;
        uint256 minAmountOut;
        bytes data;
    }

    struct TokenConfig {
        bool known; // ever allowlisted: notes of this token may exist and be spent
        bool depositsEnabled;
        bool eip3009; // supports Path B (USDC-style transferWithAuthorization + EIP-1271)
        uint128 maxDeposit;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 internal constant FIELD = ShieldedHashes.FIELD;
    uint256 internal constant MAX_AMOUNT = type(uint128).max;
    uint256 public constant MAX_ENCRYPTED_OUTPUT = 1024;
    /// ASSUMPTION: a policy proof's `timestamp` may lag block.timestamp by up to 1 hour
    /// (proof generation + relaying). Bounds how stale a budget-period decision can be.
    uint256 public constant MAX_PROOF_AGE = 1 hours;
    /// ASSUMPTION: Path-B authorizations live at most 1 hour (x402 maxTimeoutSeconds is
    /// typically <= 300s). Bounds how long reserved funds wait before reclaim.
    uint256 public constant MAX_AUTH_WINDOW = 1 hours;

    bytes32 internal constant CONTEXT_DOMAIN = keccak256("grayr.zk.context.v1");
    bytes32 internal constant LABEL_DOMAIN = keccak256("grayr.zk.label.v1");
    uint8 internal constant KIND_TRANSACT = 1;
    uint8 internal constant KIND_POLICY_PAY = 2;
    uint8 internal constant KIND_BUDGET_INIT = 3;
    uint8 internal constant KIND_AUTHORIZE = 4;
    uint8 internal constant KIND_SWAP = 5;
    uint8 internal constant KIND_PAY = 6;

    uint8 internal constant MODE_DIRECT = 0;
    uint8 internal constant MODE_ESCROW = 2;

    /// keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    /// = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267 (FiatToken EIP3009.sol)
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes4 internal constant EIP1271_MAGIC = 0x1626ba7e;

    // ------------------------------------------------------------------
    // Immutable wiring
    // ------------------------------------------------------------------

    IHonkVerifier public immutable transactVerifier;
    IHonkVerifier public immutable policyPayVerifier;
    IHonkVerifier public immutable budgetInitVerifier;
    IHonkVerifier public immutable ragequitVerifier;
    IAssociationSet public immutable associationSet;
    IVendorTree public immutable vendorTree;
    IPoseidon2 public immutable poseidon2;
    /// Refund slots and escrow lifecycle (deployed by this constructor; holds escrowed funds).
    PaymentBook public immutable paymentBook;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    MerkleTree.Tree internal _tree;
    mapping(uint256 nullifier => bool) public nullifierSpent;
    mapping(uint256 label => address) public depositorOf;
    uint256 public depositCount;
    mapping(uint256 commitment => bool) public budgetInitialized;
    mapping(address token => TokenConfig) public tokenConfig;
    mapping(address adapter => bool) public swapAdapterAllowed;
    mapping(bytes32 digest => PendingAuthorization) public pendingAuthorizations;

    // ------------------------------------------------------------------
    // Events (everything a client needs to rebuild the tree and find its notes)
    // ------------------------------------------------------------------

    event NewCommitment(uint256 indexed commitment, uint256 indexed leafIndex, bytes encryptedNote);
    event NewNullifier(uint256 indexed nullifier);
    event Deposited(
        uint256 indexed label,
        address indexed depositor,
        address indexed token,
        uint256 amount,
        uint256 commitment,
        uint256 leafIndex
    );
    event PublicPayment(
        bytes32 indexed requestId,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 fee,
        address feeRecipient
    );
    event Ragequit(uint256 indexed label, address indexed depositor, address indexed token, uint256 amount);
    /// `encryptedRefund` = ciphertext of the refund note (amount/token resolved from this event),
    /// so a wallet restored from seed can still reclaim an expired authorization.
    event TransferAuthorized(
        bytes32 indexed digest,
        address indexed to,
        address indexed token,
        uint256 value,
        uint256 validBefore,
        bytes32 nonce,
        uint256 refundCore,
        bytes encryptedRefund
    );
    event AuthorizationReclaimed(bytes32 indexed digest, uint256 commitment, uint256 leafIndex);
    /// `outLeafIndex` is the leaf of the re-shielded output note (its amount is only known onchain).
    event Swapped(
        address indexed adapter,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 outLeafIndex
    );
    /// A refund note was created for payment `id` (merchant refund or escrow return).
    event Refunded(uint256 indexed id, uint256 amount, uint256 commitment, uint256 leafIndex);
    event TokenConfigured(address indexed token, bool depositsEnabled, bool eip3009, uint128 maxDeposit);
    event SwapAdapterSet(address indexed adapter, bool allowed);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotField(uint256 value);
    error AmountTooLarge(uint256 value);
    error ZeroAmount();
    error UnknownToken(address token);
    error DepositsDisabled(address token);
    error DepositTooLarge(uint256 amount, uint256 max);
    error FeeOnTransferToken(address token);
    error UnknownRoot(uint256 root);
    error InvalidAssociationRoot(uint256 root);
    error UnknownVendorRoot(uint256 root);
    error VendorNotActive(address recipient);
    error NullifierSpent(uint256 nullifier);
    error DuplicateNullifier();
    error InvalidProof();
    error Expired(uint64 deadline);
    error BadRecipient();
    error BadFeeRecipient();
    error EncryptedOutputTooLarge();
    error StaleTimestamp(uint64 timestamp);
    error BudgetAlreadyInitialized(uint256 commitment);
    error NotADeposit(uint256 label);
    error NotEip3009(address token);
    error BadAuthorizationWindow();
    error AuthorizationExists(bytes32 digest);
    error AuthorizationNotReclaimable(bytes32 digest);
    error AdapterNotAllowed(address adapter);
    error SlippageExceeded(uint256 got, uint256 min);
    error SameToken();
    error EmptyBatch();
    error BadPayMode(uint8 mode);
    error NotPaymentBook();

    constructor(
        IHonkVerifier transactVerifier_,
        IHonkVerifier policyPayVerifier_,
        IHonkVerifier budgetInitVerifier_,
        IHonkVerifier ragequitVerifier_,
        IAssociationSet associationSet_,
        IVendorTree vendorTree_,
        IPoseidon2 poseidon2_,
        PaymentBook paymentBook_,
        address owner_
    ) Ownable(owner_) {
        transactVerifier = transactVerifier_;
        policyPayVerifier = policyPayVerifier_;
        budgetInitVerifier = budgetInitVerifier_;
        ragequitVerifier = ragequitVerifier_;
        associationSet = associationSet_;
        vendorTree = vendorTree_;
        poseidon2 = poseidon2_;
        paymentBook = paymentBook_;
    }
    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _verifyTransact(
        bytes calldata proof,
        TransactInputs calldata inputs,
        ExtData calldata ext,
        bool deferred,
        uint256 context
    ) internal {
        _verify(transactVerifier, proof, _transactPub(inputs, ext, deferred, context));
        _spend(inputs.nullifiers);
    }

    /// Every check on a transact statement's public inputs against current state (token, ext,
    /// field ranges, amounts, recipient, roots, nullifiers unspent), then its public-input
    /// vector. Used per proof (_verifyTransact) and per aggregated payment (AggregationModule).
    function _transactPub(TransactInputs calldata inputs, ExtData calldata ext, bool deferred, uint256 context)
        internal
        view
        returns (bytes32[] memory pub)
    {
        if (!tokenConfig[inputs.token].known) revert UnknownToken(inputs.token);
        _checkExt(ext);
        _checkField(inputs.nullifiers[0]);
        _checkField(inputs.nullifiers[1]);
        _checkField(inputs.outCommitments[0]);
        _checkField(inputs.outCommitments[1]);
        if (inputs.publicAmount > MAX_AMOUNT) revert AmountTooLarge(inputs.publicAmount);
        if (inputs.fee > MAX_AMOUNT) revert AmountTooLarge(inputs.fee);
        // Canonical recipient: nonzero iff something is paid out to it.
        if ((inputs.publicAmount == 0) != (inputs.recipient == address(0))) revert BadRecipient();
        if (inputs.fee != 0 && ext.feeRecipient == address(0)) revert BadFeeRecipient();
        if (!_tree.isKnownRoot(inputs.root)) revert UnknownRoot(inputs.root);
        if (!associationSet.isValidRoot(inputs.aspRoot)) revert InvalidAssociationRoot(inputs.aspRoot);
        if (inputs.nullifiers[0] == inputs.nullifiers[1]) revert DuplicateNullifier();
        if (nullifierSpent[inputs.nullifiers[0]]) revert NullifierSpent(inputs.nullifiers[0]);
        if (nullifierSpent[inputs.nullifiers[1]]) revert NullifierSpent(inputs.nullifiers[1]);

        pub = new bytes32[](12);
        pub[0] = bytes32(inputs.root);
        pub[1] = bytes32(inputs.aspRoot);
        pub[2] = bytes32(inputs.nullifiers[0]);
        pub[3] = bytes32(inputs.nullifiers[1]);
        pub[4] = bytes32(inputs.outCommitments[0]);
        pub[5] = bytes32(inputs.outCommitments[1]);
        pub[6] = bytes32(inputs.publicAmount);
        pub[7] = bytes32(inputs.fee);
        pub[8] = bytes32(uint256(uint160(inputs.token)));
        pub[9] = bytes32(uint256(uint160(inputs.recipient)));
        pub[10] = bytes32(deferred ? uint256(1) : uint256(0));
        pub[11] = bytes32(context);
    }

    /// Effects: nullifiers first, before any insertion or transfer.
    function _spend(uint256[2] calldata nullifiers) internal {
        nullifierSpent[nullifiers[0]] = true;
        nullifierSpent[nullifiers[1]] = true;
        emit NewNullifier(nullifiers[0]);
        emit NewNullifier(nullifiers[1]);
    }

    function _verifyPolicy(bytes calldata proof, PolicyInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts)
        internal
    {
        if (!tokenConfig[inputs.token].known) revert UnknownToken(inputs.token);
        _checkExt(ext);
        _checkTimestamp(inputs.timestamp);
        _checkField(inputs.nullifiers[0]);
        _checkField(inputs.nullifiers[1]);
        _checkField(inputs.budgetNullifier);
        _checkField(inputs.changeCommitment);
        _checkField(inputs.newBudgetCommitment);
        _checkField(inputs.refundCore);
        _checkMode(opts.mode, true);
        if (inputs.amount == 0) revert ZeroAmount();
        if (inputs.amount > MAX_AMOUNT) revert AmountTooLarge(inputs.amount);
        if (inputs.fee > MAX_AMOUNT) revert AmountTooLarge(inputs.fee);
        if (inputs.recipient == address(0)) revert BadRecipient();
        if (inputs.fee != 0 && ext.feeRecipient == address(0)) revert BadFeeRecipient();
        if (!_tree.isKnownRoot(inputs.root)) revert UnknownRoot(inputs.root);
        if (!associationSet.isValidRoot(inputs.aspRoot)) revert InvalidAssociationRoot(inputs.aspRoot);
        if (inputs.vendorChecked) {
            if (!vendorTree.isKnownRoot(inputs.vendorRoot)) revert UnknownVendorRoot(inputs.vendorRoot);
            // Instant suspension/revocation: the recipient is public, so check live registry status.
            if (!vendorTree.isActiveVendorWallet(inputs.recipient)) revert VendorNotActive(inputs.recipient);
        } else if (inputs.vendorRoot != 0) {
            // canonical: an unchecked vendor root carries no meaning, so it must be 0
            revert UnknownVendorRoot(inputs.vendorRoot);
        }
        uint256 n0 = inputs.nullifiers[0];
        uint256 n1 = inputs.nullifiers[1];
        uint256 nb = inputs.budgetNullifier;
        if (n0 == n1 || n0 == nb || n1 == nb) revert DuplicateNullifier();
        if (nullifierSpent[n0]) revert NullifierSpent(n0);
        if (nullifierSpent[n1]) revert NullifierSpent(n1);
        if (nullifierSpent[nb]) revert NullifierSpent(nb);

        bytes32[] memory pub = new bytes32[](16);
        pub[0] = bytes32(inputs.root);
        pub[1] = bytes32(inputs.aspRoot);
        pub[2] = bytes32(inputs.vendorRoot);
        pub[3] = bytes32(inputs.vendorChecked ? uint256(1) : 0);
        pub[4] = bytes32(n0);
        pub[5] = bytes32(n1);
        pub[6] = bytes32(nb);
        pub[7] = bytes32(inputs.changeCommitment);
        pub[8] = bytes32(inputs.newBudgetCommitment);
        pub[9] = bytes32(inputs.refundCore);
        pub[10] = bytes32(inputs.amount);
        pub[11] = bytes32(inputs.fee);
        pub[12] = bytes32(uint256(uint160(inputs.token)));
        pub[13] = bytes32(uint256(uint160(inputs.recipient)));
        pub[14] = bytes32(uint256(inputs.timestamp));
        pub[15] = bytes32(_context(KIND_POLICY_PAY, ext, _payExtra(opts)));
        _verify(policyPayVerifier, proof, pub);

        nullifierSpent[n0] = true;
        nullifierSpent[n1] = true;
        nullifierSpent[nb] = true;
        emit NewNullifier(n0);
        emit NewNullifier(n1);
        emit NewNullifier(nb);
    }

    /// Checks a deferred-mode transact proof for `pay`; returns the change commitment to insert.
    function _verifyPay(bytes calldata proof, TransactInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts)
        internal
        returns (uint256 change)
    {
        _verifyTransact(proof, inputs, ext, true, _payContext(inputs, ext, opts));
        return inputs.outCommitments[0];
    }

    /// The pay-specific checks, then the `context` a deferred-mode payment proof is bound to.
    function _payContext(TransactInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts)
        internal
        view
        returns (uint256)
    {
        _checkMode(opts.mode, false); // plain payments use transact
        if (inputs.publicAmount == 0) revert ZeroAmount();
        return _context(KIND_PAY, ext, _payExtra(opts));
    }

    function _settlePolicy(PolicyInputs calldata inputs, ExtData calldata ext, PayOptions calldata opts) internal {
        _settlePay(
            inputs.nullifiers[0], inputs.token, inputs.recipient, inputs.amount, inputs.fee, inputs.refundCore,
            inputs.vendorChecked, ext, opts
        );
    }

    /// Records the refund slot / escrow, then pays the merchant (unless escrowed) and the fee.
    function _settlePay(
        uint256 id,
        address token,
        address merchant,
        uint256 amount,
        uint256 fee,
        uint256 refundCore,
        bool vendorChecked,
        ExtData calldata ext,
        PayOptions calldata opts
    ) internal {
        _openPayment(id, token, merchant, amount, refundCore, vendorChecked, ext, opts);
        if (opts.mode == MODE_ESCROW) {
            // escrowed funds wait in the book, not the pool
            IERC20(token).safeTransfer(address(paymentBook), amount);
            _payout(token, address(0), 0, fee, ext);
        } else {
            _payout(token, merchant, amount, fee, ext);
        }
    }

    /// Records the refund slot / escrow of a non-direct payment in the PaymentBook.
    function _openPayment(
        uint256 id,
        address token,
        address merchant,
        uint256 amount,
        uint256 refundCore,
        bool vendorChecked,
        ExtData calldata ext,
        PayOptions calldata opts
    ) internal {
        if (opts.mode != MODE_DIRECT) {
            // id = first nullifier: unique, because it was just marked spent. The book checks
            // the terms, stores keccak(record) and emits PaymentRecorded.
            paymentBook.open(
                id,
                PaymentRecord({
                    mode: opts.mode,
                    vendorChecked: vendorChecked,
                    merchant: merchant,
                    token: token,
                    amount: uint128(amount),
                    refundCore: refundCore,
                    arbiter: opts.arbiter,
                    claimableAt: opts.claimableAt,
                    expiresAt: opts.expiresAt,
                    payerAuth: opts.payerAuth
                }),
                ext.requestId,
                opts.encryptedRefund
            );
        }
    }

    /// Terms are validated by PaymentBook.open (non-direct modes); here only the mode itself.
    function _checkMode(uint8 mode, bool allowDirect) internal pure {
        if (mode > MODE_ESCROW || (mode == MODE_DIRECT && !allowDirect)) revert BadPayMode(mode);
    }

    function _payExtra(PayOptions calldata o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o.mode, o.arbiter, o.claimableAt, o.expiresAt, o.payerAuth, keccak256(o.encryptedRefund)));
    }

    function _verify(IHonkVerifier verifier, bytes calldata proof, bytes32[] memory pub) internal view {
        // The generated verifier reverts on malformed input and returns false on a bad proof;
        // both mean rejection.
        try verifier.verify(proof, pub) returns (bool ok) {
            if (!ok) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }
    }

    function _context(uint8 kind, ExtData calldata ext, bytes32 extra) internal view returns (uint256) {
        return ShieldedHashes.toField(
            keccak256(
                abi.encode(
                    CONTEXT_DOMAIN,
                    block.chainid,
                    address(this),
                    kind,
                    ext.feeRecipient,
                    ext.requestId,
                    ext.deadline,
                    keccak256(ext.encryptedOutput0),
                    keccak256(ext.encryptedOutput1),
                    extra
                )
            )
        );
    }

    function _checkExt(ExtData calldata ext) internal view {
        if (ext.deadline < block.timestamp) revert Expired(ext.deadline);
        if (ext.encryptedOutput0.length > MAX_ENCRYPTED_OUTPUT || ext.encryptedOutput1.length > MAX_ENCRYPTED_OUTPUT) {
            revert EncryptedOutputTooLarge();
        }
    }

    function _checkTimestamp(uint64 ts) internal view {
        if (ts > block.timestamp || block.timestamp - ts > MAX_PROOF_AGE) revert StaleTimestamp(ts);
    }

    /// Public inputs must be canonical field elements: otherwise x and x + FIELD would be the
    /// same value to the verifier but different keys in `nullifierSpent` (double spend).
    function _checkField(uint256 x) internal pure {
        if (x >= FIELD) revert NotField(x);
    }

    function _emitOutputs(uint256 start, uint256[] memory leaves, ExtData calldata ext) internal {
        emit NewCommitment(leaves[0], start, ext.encryptedOutput0);
        emit NewCommitment(leaves[1], start + 1, ext.encryptedOutput1);
    }

    function _payout(address token, address recipient, uint256 amount, uint256 fee, ExtData calldata ext) internal {
        if (amount != 0) {
            IERC20(token).safeTransfer(recipient, amount);
            emit PublicPayment(ext.requestId, recipient, token, amount, fee, ext.feeRecipient);
        }
        if (fee != 0) IERC20(token).safeTransfer(ext.feeRecipient, fee);
    }
}
