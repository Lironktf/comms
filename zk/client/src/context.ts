import {encodeAbiParameters, keccak256, type Address, type Hex} from "viem";
import {P} from "./field.js";

/** Spend kinds; must match ShieldedPool.KIND_* (the kind is hashed into the context). */
export const KIND = {TRANSACT: 1, POLICY_PAY: 2, BUDGET_INIT: 3, AUTHORIZE: 4, SWAP: 5, PAY: 6} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export interface ExtData {
  feeRecipient: Address;
  requestId: Hex; // bytes32
  deadline: bigint; // uint64 unix seconds
  encryptedOutput0: Hex;
  encryptedOutput1: Hex;
}

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const CONTEXT_DOMAIN = keccak256(new TextEncoder().encode("grayr.zk.context.v1"));

/**
 * The `context` public input. Mirrors ShieldedPool._context exactly:
 *   keccak256(abi.encode(DOMAIN, chainId, pool, kind, feeRecipient, requestId, deadline,
 *                        keccak(enc0), keccak(enc1), extra)) mod P
 * The contract recomputes it from calldata + block.chainid + address(this), so a proof made
 * for one chain/pool/relayer/request/deadline/ciphertext is useless for any other.
 */
export function computeContext(chainId: bigint, pool: Address, kind: Kind, ext: ExtData, extra: Hex = ZERO_BYTES32): bigint {
  const enc = encodeAbiParameters(
    [
      {type: "bytes32"}, {type: "uint256"}, {type: "address"}, {type: "uint8"}, {type: "address"},
      {type: "bytes32"}, {type: "uint64"}, {type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"},
    ],
    [
      CONTEXT_DOMAIN, chainId, pool, kind, ext.feeRecipient, ext.requestId, ext.deadline,
      keccak256(ext.encryptedOutput0), keccak256(ext.encryptedOutput1), extra,
    ],
  );
  return BigInt(keccak256(enc)) % P;
}

export function authorizeExtra(validAfter: bigint, validBefore: bigint, nonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{type: "uint256"}, {type: "uint256"}, {type: "bytes32"}], [validAfter, validBefore, nonce]));
}

export function swapExtra(adapter: Address, tokenOut: Address, minAmountOut: bigint, data: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "address"}, {type: "address"}, {type: "uint256"}, {type: "bytes32"}],
      [adapter, tokenOut, minAmountOut, keccak256(data)],
    ),
  );
}

/** Payment modes; must match ShieldedPool/PaymentBook MODE_*. */
export const PAY_MODE = {DIRECT: 0, REFUNDABLE: 1, ESCROW: 2} as const;
export type PayMode = (typeof PAY_MODE)[keyof typeof PAY_MODE];

/** ShieldedPool.PayOptions: how a payment settles (bound into the proof via `context`). */
export interface PayOptions {
  mode: PayMode;
  arbiter: Address;
  claimableAt: bigint; // uint64
  expiresAt: bigint; // uint64
  payerAuth: Hex; // bytes32
  encryptedRefund: Hex;
}

export const DIRECT_PAYMENT: PayOptions = {
  mode: PAY_MODE.DIRECT, arbiter: ZERO_ADDRESS, claimableAt: 0n, expiresAt: 0n, payerAuth: ZERO_BYTES32, encryptedRefund: "0x",
};

/** Mirrors ShieldedPool._payExtra. */
export function payExtra(o: PayOptions): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "uint8"}, {type: "address"}, {type: "uint64"}, {type: "uint64"}, {type: "bytes32"}, {type: "bytes32"}],
      [o.mode, o.arbiter, o.claimableAt, o.expiresAt, o.payerAuth, keccak256(o.encryptedRefund)],
    ),
  );
}

/**
 * Escrow secrets, derived from the spending key and the refund core so a wallet restored from
 * seed can still release or dispute. Two independent secrets: revealing the release secret
 * (to whoever submits the release) doesn't let them dispute instead.
 *   payerAuth = keccak(abi.encode(keccak(abi.encode(release)), keccak(abi.encode(dispute))))
 */
export function escrowSecrets(sk: bigint, refundCore: bigint): {release: Hex; dispute: Hex; releaseHash: Hex; disputeHash: Hex; payerAuth: Hex} {
  const derive = (tag: string) =>
    keccak256(encodeAbiParameters([{type: "string"}, {type: "uint256"}, {type: "uint256"}], [tag, sk, refundCore]));
  const release = derive("grayr.zk.escrow.release.v1");
  const dispute = derive("grayr.zk.escrow.dispute.v1");
  const h = (x: Hex) => keccak256(encodeAbiParameters([{type: "bytes32"}], [x]));
  const releaseHash = h(release);
  const disputeHash = h(dispute);
  const payerAuth = keccak256(encodeAbiParameters([{type: "bytes32"}, {type: "bytes32"}], [releaseHash, disputeHash]));
  return {release, dispute, releaseHash, disputeHash, payerAuth};
}

export function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString("hex")}`;
}
