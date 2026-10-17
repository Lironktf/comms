// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVendorTree} from "./interfaces/IVendorTree.sol";

/// Immutable facts of a refundable/escrowed payment, emitted by the pool in PaymentRecorded.
/// Only keccak256(abi.encode(record)) is stored; callers pass the record back.
struct PaymentRecord {
    uint8 mode; // 1 REFUNDABLE, 2 ESCROW
    bool vendorChecked; // paid under a policy that required a verified Grayr vendor
    address merchant;
    address token;
    uint128 amount;
    uint256 refundCore; // core of the payer's refund note (bound in the payment proof)
    address arbiter; // ESCROW: may resolve disputes (0 = none)
    uint64 claimableAt; // ESCROW: merchant may claim from here; payer may dispute before
    uint64 expiresAt; // ESCROW: from here an unclaimed/unresolved escrow returns to the payer
    bytes32 payerAuth; // ESCROW: keccak(abi.encode(keccak(releaseSecret), keccak(disputeSecret)))
}

interface IRefundShielder {
    function shieldRefund(uint256 id, address token, uint256 amount, uint256 refundCore)
        external
        returns (uint256 commitment, uint256 leafIndex);
}

/// @title PaymentBook — refunds and escrow for ShieldedPool payments.
/// @notice Deployed by the pool's constructor, so `pool` is fixed and trusted. The pool opens a
///         record when it settles a REFUNDABLE or ESCROW payment (and sends escrowed funds
///         here). Everything that gives money back goes through the pool's `shieldRefund`, which
///         inserts a note only the payer can spend, under the label (and, for agents, the policy)
///         the payment proof committed to. Nobody here learns who the payer is: the payer acts
///         only through secrets its wallet derives, submitted from any address.
///
///         REFUNDABLE: merchant was paid at once; `refund` pulls up to `amount` back from it.
///         ESCROW:     funds wait here.
///           releaseEscrow  payer approves         -> merchant paid in full, any time
///           disputeEscrow  payer, before claimableAt, only with an arbiter
///           claimEscrow    merchant, in [claimableAt, expiresAt), undisputed; may refund part.
///                          A FULL refund (cancel) is allowed any time.
///           resolveEscrow  arbiter, disputed, before expiresAt: any split
///           expireEscrow   anyone, from expiresAt -> payer refunded in full
contract PaymentBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 internal constant MODE_REFUNDABLE = 1;
    uint8 internal constant MODE_ESCROW = 2;
    uint8 internal constant OPEN = 0;
    uint8 internal constant DISPUTED = 1;
    uint8 internal constant CLOSED = 2;

    struct PaymentState {
        uint8 status; // OPEN, DISPUTED, CLOSED
        uint128 refunded; // REFUNDABLE: cumulative refunds
    }

    /// ASSUMPTION: 90 days covers delivery + dispute windows for API/agent purchases. Bounds
    /// how long escrowed funds can be locked. Overturned by real dispute-timing data.
    uint256 public constant MAX_ESCROW_DURATION = 90 days;
    uint256 public constant MAX_ENCRYPTED_REFUND = 1024;

    address public immutable pool;
    IVendorTree public immutable vendorTree;

    /// payment id (= its first nullifier) => keccak256(abi.encode(PaymentRecord))
    mapping(uint256 id => bytes32) public recordHash;
    mapping(uint256 id => PaymentState) public state;

    /// A refundable or escrowed payment. `id` is the payment's first nullifier; `requestId` is
    /// the x402 request it paid for (so a merchant can refund "request X").
    event PaymentRecorded(
        uint256 indexed id, address indexed merchant, bytes32 indexed requestId, PaymentRecord record, bytes encryptedRefund
    );
    event EscrowDisputed(uint256 indexed id);
    /// Escrow closed: the merchant got `toMerchant`, the payer's refund note got `refunded`.
    event EscrowClosed(uint256 indexed id, uint256 toMerchant, uint256 refunded);
    event PublicPayment(
        bytes32 indexed requestId,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 fee,
        address feeRecipient
    );

    error NotPool();
    error ZeroAmount();
    error FeeOnTransferToken(address token);
    error VendorNotActive(address recipient);
    error BadPayMode(uint8 mode);
    error BadEscrowTerms();
    error EncryptedOutputTooLarge();
    error UnknownPayment(uint256 id);
    error PaymentClosed(uint256 id);
    error NotMerchant();
    error NotArbiter();
    error BadPayerSecret();
    error RefundTooLarge(uint256 amount, uint256 max);
    error EscrowNotClaimable(uint256 id);
    error DisputeWindowOver(uint256 id);
    error NoArbiter(uint256 id);
    error NotDisputed(uint256 id);
    error NotExpired(uint256 id);

    constructor(IVendorTree vendorTree_) {
        pool = msg.sender;
        vendorTree = vendorTree_;
    }

    /// @notice Called by the pool when it settles a refundable/escrowed payment (after the
    ///         proof, which binds every field of these terms, has been verified).
    function open(uint256 id, PaymentRecord calldata rec, bytes32 requestId, bytes calldata encryptedRefund) external {
        if (msg.sender != pool) revert NotPool();
        if (encryptedRefund.length > MAX_ENCRYPTED_REFUND) revert EncryptedOutputTooLarge();
        if (rec.mode == MODE_ESCROW) {
            if (
                rec.claimableAt < block.timestamp || rec.expiresAt <= rec.claimableAt
                    || rec.expiresAt > block.timestamp + MAX_ESCROW_DURATION || rec.payerAuth == bytes32(0)
            ) revert BadEscrowTerms();
        } else if (rec.mode == MODE_REFUNDABLE) {
            // canonical: escrow-only fields must be empty
            if (rec.arbiter != address(0) || rec.claimableAt != 0 || rec.expiresAt != 0 || rec.payerAuth != 0) {
                revert BadEscrowTerms();
            }
        } else {
            revert BadPayMode(rec.mode);
        }
        recordHash[id] = keccak256(abi.encode(rec)); // id is a freshly spent nullifier: never reused
        emit PaymentRecorded(id, rec.merchant, requestId, rec, encryptedRefund);
    }

    /// @notice The merchant of a REFUNDABLE payment returns `amount` (pulled from the merchant,
    ///         which must have approved this book) as a private note only the payer can spend.
    ///         Partial refunds are allowed up to the amount paid. The merchant never learns who
    ///         the payer is; it knows the payment only by its id.
    function refund(uint256 id, PaymentRecord calldata rec, uint128 amount)
        external
        nonReentrant
        returns (uint256 commitment, uint256 leafIndex)
    {
        PaymentState storage st = _open(id, rec);
        if (rec.mode != MODE_REFUNDABLE) revert BadPayMode(rec.mode);
        if (msg.sender != rec.merchant) revert NotMerchant();
        if (amount == 0) revert ZeroAmount();
        uint256 total = uint256(st.refunded) + amount;
        if (total > rec.amount) revert RefundTooLarge(amount, rec.amount - st.refunded);
        st.refunded = uint128(total);
        if (total == rec.amount) st.status = CLOSED;

        uint256 before = IERC20(rec.token).balanceOf(address(this));
        IERC20(rec.token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(rec.token).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken(rec.token);
        return _shield(id, rec, amount);
    }

    /// @notice The payer approves an escrow: the merchant is paid in full now. Authenticated by
    ///         `releaseSecret`; `disputeHash` is the other half of payerAuth. Revealing the
    ///         release secret doesn't reveal the dispute secret, so a submitter who sees this
    ///         call can't turn it into a dispute.
    function releaseEscrow(uint256 id, PaymentRecord calldata rec, bytes32 releaseSecret, bytes32 disputeHash)
        external
        nonReentrant
    {
        _open(id, rec);
        if (rec.mode != MODE_ESCROW) revert BadPayMode(rec.mode);
        if (keccak256(abi.encode(keccak256(abi.encode(releaseSecret)), disputeHash)) != rec.payerAuth) {
            revert BadPayerSecret();
        }
        _close(id, rec, rec.amount);
    }

    /// @notice The payer disputes before `claimableAt`; only possible if an arbiter was chosen.
    function disputeEscrow(uint256 id, PaymentRecord calldata rec, bytes32 disputeSecret, bytes32 releaseHash)
        external
        nonReentrant
    {
        PaymentState storage st = _open(id, rec);
        if (rec.mode != MODE_ESCROW) revert BadPayMode(rec.mode);
        if (rec.arbiter == address(0)) revert NoArbiter(id);
        if (st.status != OPEN) revert PaymentClosed(id);
        if (block.timestamp >= rec.claimableAt) revert DisputeWindowOver(id);
        if (keccak256(abi.encode(releaseHash, keccak256(abi.encode(disputeSecret)))) != rec.payerAuth) {
            revert BadPayerSecret();
        }
        st.status = DISPUTED;
        emit EscrowDisputed(id);
    }

    /// @notice The merchant settles: keeps `amount - refundAmount`, returns `refundAmount` to the
    ///         payer's note. A FULL refund is allowed any time (also while disputed); otherwise
    ///         only undisputed, in [claimableAt, expiresAt). If the payment required a verified
    ///         vendor, the merchant must still be an Active Grayr vendor to collect.
    function claimEscrow(uint256 id, PaymentRecord calldata rec, uint128 refundAmount) external nonReentrant {
        PaymentState storage st = _open(id, rec);
        if (rec.mode != MODE_ESCROW) revert BadPayMode(rec.mode);
        if (msg.sender != rec.merchant) revert NotMerchant();
        if (refundAmount > rec.amount) revert RefundTooLarge(refundAmount, rec.amount);
        if (refundAmount < rec.amount) {
            if (st.status != OPEN || block.timestamp < rec.claimableAt || block.timestamp >= rec.expiresAt) {
                revert EscrowNotClaimable(id);
            }
            if (rec.vendorChecked && !vendorTree.isActiveVendorWallet(rec.merchant)) revert VendorNotActive(rec.merchant);
        }
        _close(id, rec, rec.amount - refundAmount);
    }

    /// @notice The arbiter resolves a dispute before `expiresAt`: the merchant gets `toMerchant`,
    ///         the rest goes back to the payer's note.
    function resolveEscrow(uint256 id, PaymentRecord calldata rec, uint128 toMerchant) external nonReentrant {
        PaymentState storage st = _open(id, rec);
        if (msg.sender != rec.arbiter) revert NotArbiter();
        if (st.status != DISPUTED) revert NotDisputed(id);
        if (block.timestamp >= rec.expiresAt) revert EscrowNotClaimable(id);
        if (toMerchant > rec.amount) revert RefundTooLarge(toMerchant, rec.amount);
        _close(id, rec, toMerchant);
    }

    /// @notice From `expiresAt`, anyone can return an unclaimed or unresolved escrow to the payer.
    function expireEscrow(uint256 id, PaymentRecord calldata rec) external nonReentrant {
        _open(id, rec);
        if (rec.mode != MODE_ESCROW) revert BadPayMode(rec.mode);
        if (block.timestamp < rec.expiresAt) revert NotExpired(id);
        _close(id, rec, 0);
    }

    function _open(uint256 id, PaymentRecord calldata rec) internal view returns (PaymentState storage st) {
        bytes32 h = recordHash[id];
        if (h == bytes32(0) || h != keccak256(abi.encode(rec))) revert UnknownPayment(id);
        st = state[id];
        if (st.status == CLOSED) revert PaymentClosed(id);
    }

    function _close(uint256 id, PaymentRecord calldata rec, uint256 toMerchant) internal {
        state[id].status = CLOSED;
        uint256 back = rec.amount - toMerchant;
        emit EscrowClosed(id, toMerchant, back);
        if (back != 0) _shield(id, rec, back);
        if (toMerchant != 0) {
            IERC20(rec.token).safeTransfer(rec.merchant, toMerchant);
            emit PublicPayment(bytes32(id), rec.merchant, rec.token, toMerchant, 0, address(0));
        }
    }

    function _shield(uint256 id, PaymentRecord calldata rec, uint256 amount)
        internal
        returns (uint256 commitment, uint256 leafIndex)
    {
        IERC20(rec.token).safeTransfer(pool, amount);
        return IRefundShielder(pool).shieldRefund(id, rec.token, amount, rec.refundCore);
    }
}
