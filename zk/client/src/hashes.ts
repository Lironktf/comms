/**
 * Protocol hashes: a 1:1 mirror of zk/circuits/lib/src/lib.nr. If you change one,
 * change all three (Noir, Solidity ShieldedHashes.sol, this file) and regenerate
 * zk/test-vectors/vectors.json; the test suites will tell you if they diverge.
 */
import {P, poseidon2} from "./poseidon2.js";

export const TAG = {NK: 1n, OWNER: 2n, NOTE: 3n, NULL: 4n, BUDGET: 5n, POLICY: 6n, ADMIN: 7n, VENDOR: 8n} as const;

export const NOTE_TREE_DEPTH = 20;
export const ASP_TREE_DEPTH = 20;
export const VENDOR_TREE_DEPTH = 20;

export const h2 = (a: bigint, b: bigint) => poseidon2([a, b]);
export const h3 = (a: bigint, b: bigint, c: bigint) => poseidon2([a, b, c]);

/** Reject anything that is not a canonical field element (never silently reduce). */
export function assertField(x: bigint, what = "value"): bigint {
  if (x < 0n || x >= P) throw new Error(`${what} is not a canonical BN254 field element`);
  return x;
}

export const U128_MAX = (1n << 128n) - 1n;
export function assertU128(x: bigint, what = "amount"): bigint {
  if (x < 0n || x > U128_MAX) throw new Error(`${what} must fit in u128`);
  return x;
}

// keys
export const nullifierKey = (sk: bigint) => h3(TAG.NK, sk, 0n);
export const ownerPk = (sk: bigint) => h3(TAG.OWNER, sk, 0n);
export const adminPk = (adminSk: bigint) => h3(TAG.ADMIN, adminSk, 0n);

// notes
export const noteInner = (owner: bigint, blinding: bigint, policy: bigint) => h3(owner, blinding, policy);
export const noteCore = (label: bigint, inner: bigint) => h3(TAG.NOTE, label, inner);
export const commitmentFromCore = (amount: bigint, token: bigint, core: bigint) => h3(amount, token, core);

export function noteCommitment(n: {
  amount: bigint;
  token: bigint;
  label: bigint;
  owner: bigint;
  blinding: bigint;
  policy: bigint;
}): bigint {
  return commitmentFromCore(n.amount, n.token, noteCore(n.label, noteInner(n.owner, n.blinding, n.policy)));
}

export function budgetCommitment(b: {
  remaining: bigint;
  period: bigint;
  owner: bigint;
  blinding: bigint;
  policy: bigint;
}): bigint {
  return h3(b.remaining, b.period, h3(TAG.BUDGET, 0n, noteInner(b.owner, b.blinding, b.policy)));
}

export const nullifier = (nk: bigint, cm: bigint, leafIndex: bigint) => h3(TAG.NULL, nk, h2(cm, leafIndex));

// policy + vendors
export interface PolicyParams {
  adminPk: bigint;
  token: bigint;
  maxPerPayment: bigint;
  maxFee: bigint;
  periodBudget: bigint;
  periodSeconds: bigint;
  minVendorLevel: bigint;
  /** bitmask of allowed merchant categories; 0 = unrestricted */
  categoryMask: bigint;
  /** true: only Grayr-verified vendors (level + category checks); false: any recipient */
  requireVerifiedVendor: boolean;
}

export function policyHash(p: PolicyParams): bigint {
  return h3(
    TAG.POLICY,
    h3(p.adminPk, p.token, p.maxPerPayment),
    h3(h3(p.maxFee, p.periodBudget, p.periodSeconds), h3(p.minVendorLevel, p.categoryMask, p.requireVerifiedVendor ? 1n : 0n), 0n),
  );
}

export const vendorLeaf = (wallet: bigint, level: bigint, categories: bigint, expiry: bigint) =>
  h3(TAG.VENDOR, wallet, h3(level, categories, expiry));
