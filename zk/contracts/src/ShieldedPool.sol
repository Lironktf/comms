// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IHonkVerifier} from "./interfaces/IHonkVerifier.sol";
import {IAssociationSet} from "./interfaces/IAssociationSet.sol";
import {IVendorTree} from "./interfaces/IVendorTree.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IPoseidon2} from "./interfaces/IPoseidon2.sol";
import {MerkleTree} from "./libraries/MerkleTree.sol";
import {ShieldedHashes} from "./libraries/ShieldedHashes.sol";

/// @title ShieldedPool — private agent payments on Base.
/// @notice One vault holding everyone's tokens plus a Merkle tree of note commitments.
///         No balances are stored per user. Spending = a zero-knowledge proof of owning
///         an unspent note; the pool pays the merchant DIRECTLY in the same transaction.
///         The public sees "the pool paid M $X", never who paid.
///
///         Entry points:
///           deposit             public: tokens in, commitment inserted, label assigned
///           transact[Batch]     private transfer / pay a merchant / withdraw (2-in-2-out)
///           payWithPolicy[Batch] agent payment with spending policy enforced in-proof
///           initBudget          policy admin mints an agent's budget note
///           ragequit            public exit to the original depositor (compliance)
///           authorizeTransfer   Path B: approve one EIP-3009 transfer FROM the pool (EIP-1271)
///           reclaimAuthorization refund an expired, unused Path-B authorization as a note
///           swap                private swap through an allowlisted adapter (Railgun-style)
///
///         Ordering in every spend (checks-effects-interactions): validate public inputs and
///         roots -> verify proof -> record nullifiers -> insert commitments -> external transfers.
///
///         The owner can ONLY configure tokens (enable deposits, caps) and allowlist swap
///         adapters. It cannot move, freeze or redirect funds, and cannot pause spends or
///         ragequit. The contract is not upgradeable.
contract ShieldedPool is ReentrancyGuard, Ownable2Step {
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

    struct PolicyCall {
        bytes proof;
        PolicyInputs inputs;
        ExtData ext;
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

    constructor(
        IHonkVerifier transactVerifier_,
        IHonkVerifier policyPayVerifier_,
        IHonkVerifier budgetInitVerifier_,
        IHonkVerifier ragequitVerifier_,
        IAssociationSet associationSet_,
        IVendorTree vendorTree_,
        IPoseidon2 poseidon2_,
        address owner_
    ) Ownable(owner_) {
        transactVerifier = transactVerifier_;
        policyPayVerifier = policyPayVerifier_;
        budgetInitVerifier = budgetInitVerifier_;
        ragequitVerifier = ragequitVerifier_;
        associationSet = associationSet_;
        vendorTree = vendorTree_;
        poseidon2 = poseidon2_;
        _tree.init();
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

    /// @notice Submit many transact proofs in one transaction (relayers/facilitators).
    ///         All proofs must be valid (atomic). Payments can go to different merchants.
    ///         Saves the per-tx base cost and inserts all outputs as ONE tree batch.
    function transactBatch(TransactCall[] calldata calls) external nonReentrant {
        uint256 n = calls.length;
        if (n == 0) revert EmptyBatch();
        uint256[] memory leaves = new uint256[](2 * n);
        for (uint256 i; i < n; ++i) {
            TransactCall calldata c = calls[i];
            _verifyTransact(c.proof, c.inputs, c.ext, false, _context(KIND_TRANSACT, c.ext, bytes32(0)));
            leaves[2 * i] = c.inputs.outCommitments[0];
            leaves[2 * i + 1] = c.inputs.outCommitments[1];
        }
        uint256 start = _tree.insert(poseidon2, leaves);
        for (uint256 i; i < n; ++i) {
            TransactCall calldata c = calls[i];
            emit NewCommitment(leaves[2 * i], start + 2 * i, c.ext.encryptedOutput0);
            emit NewCommitment(leaves[2 * i + 1], start + 2 * i + 1, c.ext.encryptedOutput1);
        }
        for (uint256 i; i < n; ++i) {
            TransactCall calldata c = calls[i];
            _payout(c.inputs.token, c.inputs.recipient, c.inputs.publicAmount, c.inputs.fee, c.ext);
        }
    }

    // ------------------------------------------------------------------
    // Spends: policy-enforced agent payments
    // ------------------------------------------------------------------

    function payWithPolicy(bytes calldata proof, PolicyInputs calldata inputs, ExtData calldata ext)
        external
        nonReentrant
    {
        _verifyPolicy(proof, inputs, ext);
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = inputs.changeCommitment;
        leaves[1] = inputs.newBudgetCommitment;
        uint256 start = _tree.insert(poseidon2, leaves);
        _emitOutputs(start, leaves, ext);
        _payout(inputs.token, inputs.recipient, inputs.amount, inputs.fee, ext);
    }

    function payWithPolicyBatch(PolicyCall[] calldata calls) external nonReentrant {
        uint256 n = calls.length;
        if (n == 0) revert EmptyBatch();
        uint256[] memory leaves = new uint256[](2 * n);
        for (uint256 i; i < n; ++i) {
            PolicyCall calldata c = calls[i];
            _verifyPolicy(c.proof, c.inputs, c.ext);
            leaves[2 * i] = c.inputs.changeCommitment;
            leaves[2 * i + 1] = c.inputs.newBudgetCommitment;
        }
        uint256 start = _tree.insert(poseidon2, leaves);
        for (uint256 i; i < n; ++i) {
            PolicyCall calldata c = calls[i];
            emit NewCommitment(leaves[2 * i], start + 2 * i, c.ext.encryptedOutput0);
            emit NewCommitment(leaves[2 * i + 1], start + 2 * i + 1, c.ext.encryptedOutput1);
        }
        for (uint256 i; i < n; ++i) {
            PolicyCall calldata c = calls[i];
            _payout(c.inputs.token, c.inputs.recipient, c.inputs.amount, c.inputs.fee, c.ext);
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

        bytes32[] memory pub = new bytes32[](12);
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
        _verify(transactVerifier, proof, pub);

        // Effects: nullifiers first, before any insertion or transfer.
        nullifierSpent[inputs.nullifiers[0]] = true;
        nullifierSpent[inputs.nullifiers[1]] = true;
        emit NewNullifier(inputs.nullifiers[0]);
        emit NewNullifier(inputs.nullifiers[1]);
    }

    function _verifyPolicy(bytes calldata proof, PolicyInputs calldata inputs, ExtData calldata ext) internal {
        if (!tokenConfig[inputs.token].known) revert UnknownToken(inputs.token);
        _checkExt(ext);
        _checkTimestamp(inputs.timestamp);
        _checkField(inputs.nullifiers[0]);
        _checkField(inputs.nullifiers[1]);
        _checkField(inputs.budgetNullifier);
        _checkField(inputs.changeCommitment);
        _checkField(inputs.newBudgetCommitment);
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

        bytes32[] memory pub = new bytes32[](15);
        pub[0] = bytes32(inputs.root);
        pub[1] = bytes32(inputs.aspRoot);
        pub[2] = bytes32(inputs.vendorRoot);
        pub[3] = bytes32(inputs.vendorChecked ? uint256(1) : 0);
        pub[4] = bytes32(n0);
        pub[5] = bytes32(n1);
        pub[6] = bytes32(nb);
        pub[7] = bytes32(inputs.changeCommitment);
        pub[8] = bytes32(inputs.newBudgetCommitment);
        pub[9] = bytes32(inputs.amount);
        pub[10] = bytes32(inputs.fee);
        pub[11] = bytes32(uint256(uint160(inputs.token)));
        pub[12] = bytes32(uint256(uint160(inputs.recipient)));
        pub[13] = bytes32(uint256(inputs.timestamp));
        pub[14] = bytes32(_context(KIND_POLICY_PAY, ext, bytes32(0)));
        _verify(policyPayVerifier, proof, pub);

        nullifierSpent[n0] = true;
        nullifierSpent[n1] = true;
        nullifierSpent[nb] = true;
        emit NewNullifier(n0);
        emit NewNullifier(n1);
        emit NewNullifier(nb);
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
