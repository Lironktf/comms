/**
 * Standalone (no chain) valid witnesses for every circuit. Used by:
 *   - scripts/bench-prove.ts      proving-time benchmarks (M7)
 *   - scripts/gen-fixtures.ts     proof fixtures for the Foundry verifier tests (gas + tamper tests)
 * Each witness is a small self-consistent world: a tree with the needed notes, an ASP set,
 * a vendor tree, and a policy.
 */
import type {InputMap} from "@noir-lang/noir_js";
import {
  adminPk, budgetCommitment, h3, noteCommitment, noteCore, noteInner, nullifier, nullifierKey, ownerPk, policyHash,
  vendorLeaf, type PolicyParams,
} from "../src/hashes.js";
import {MerkleTree} from "../src/merkle.js";
import type {CircuitName} from "../src/prover.js";

const s = (x: bigint | number) => x.toString();
const arr = (xs: readonly bigint[]) => xs.map(s);

export const FIX = {
  sk: 0x1234n,
  adminSk: 0x99n,
  token: 0x59b670e9fa9d0a427751af201d676719a970857bn,
  label: 0x0777n,
  merchant: 0x9965507d1a55bcc2695c58ba16fb37d819b0a4dcn,
  now: 1_800_000_000n,
  context: 0x0abcdefn,
};

function policyInput(p: PolicyParams | null): InputMap {
  const z = p ?? {adminPk: 0n, token: 0n, maxPerPayment: 0n, maxFee: 0n, periodBudget: 0n, periodSeconds: 0n, minVendorLevel: 0n, categoryMask: 0n, requireVerifiedVendor: false};
  return {
    admin_pk: s(z.adminPk), token: s(z.token), max_per_payment: s(z.maxPerPayment), max_fee: s(z.maxFee),
    period_budget: s(z.periodBudget), period_seconds: s(z.periodSeconds), min_vendor_level: s(z.minVendorLevel), category_mask: s(z.categoryMask), require_verified_vendor: z.requireVerifiedVendor,
  };
}

export const POLICY: PolicyParams = {
  adminPk: adminPk(FIX.adminSk), token: FIX.token, maxPerPayment: 10_000000n, maxFee: 50_000n,
  periodBudget: 500_000000n, periodSeconds: 2_592_000n, minVendorLevel: 2n, categoryMask: 0b110n, requireVerifiedVendor: true,
};

export function witness(name: CircuitName): InputMap {
  const owner = ownerPk(FIX.sk);
  const nk = nullifierKey(FIX.sk);
  const tree = new MerkleTree(20);
  const asp = new MerkleTree(20);
  asp.insert([11n, FIX.label, 13n]);
  const aspIdx = 1;

  if (name === "m0_commitment") {
    return {commitment: s(h3(42n, 7n, 0n)), amount: "42", secret: "7"};
  }
  if (name === "m0_merkle") {
    tree.insert([1n, 2n, 123n]);
    return {root: s(tree.root), leaf: "123", index: "2", path: arr(tree.path(2))};
  }
  if (name === "transact") {
    const n0 = {amount: 60_000000n, token: FIX.token, label: FIX.label, owner, blinding: 7n, policy: 0n};
    const n1 = {amount: 40_000000n, token: FIX.token, label: FIX.label, owner, blinding: 8n, policy: 0n};
    tree.insert([noteCommitment(n0), noteCommitment(n1)]);
    const out0 = {amount: 94_900000n, token: FIX.token, label: FIX.label, owner, blinding: 11n, policy: 0n};
    const out1 = {amount: 0n, token: FIX.token, label: FIX.label, owner, blinding: 12n, policy: 0n};
    return {
      root: s(tree.root), asp_root: s(asp.root),
      nullifiers: arr([nullifier(nk, noteCommitment(n0), 0n), nullifier(nk, noteCommitment(n1), 1n)]),
      out_commitments: arr([noteCommitment(out0), noteCommitment(out1)]),
      public_amount: "5000000", fee: "100000", token: s(FIX.token), recipient: s(FIX.merchant), deferred: false, context: s(FIX.context),
      sk: s(FIX.sk), label: s(FIX.label), asp_index: s(aspIdx), asp_path: arr(asp.path(aspIdx)),
      policy: "0", policy_params: policyInput(null), admin_sk: "0",
      in_amounts: [s(n0.amount), s(n1.amount)], in_blindings: ["7", "8"], in_indices: ["0", "1"],
      in_paths: [arr(tree.path(0)), arr(tree.path(1))],
      out_amounts: [s(out0.amount), "0"], out_owners: [s(owner), s(owner)], out_blindings: ["11", "12"], out_policies: ["0", "0"],
    };
  }
  if (name === "policy_pay") {
    const pol = policyHash(POLICY);
    const n0 = {amount: 100_000000n, token: FIX.token, label: FIX.label, owner, blinding: 7n, policy: pol};
    const period = FIX.now / POLICY.periodSeconds;
    const b = {remaining: 20_000000n, period, owner, blinding: 9n, policy: pol};
    tree.insert([noteCommitment(n0), budgetCommitment(b)]);
    const vendors = new MerkleTree(20);
    const expiry = FIX.now + 7n * 86400n;
    vendors.insert([vendorLeaf(1n, 1n, 1n, expiry), vendorLeaf(FIX.merchant, 3n, 0b010n, expiry)]);
    const dummy = {amount: 0n, token: FIX.token, label: FIX.label, owner, blinding: 8n, policy: pol};
    const amount = 5_000000n, fee = 10_000n;
    const change = {amount: n0.amount - amount - fee, token: FIX.token, label: FIX.label, owner, blinding: 11n, policy: pol};
    const nb = {remaining: b.remaining - amount - fee, period, owner, blinding: 12n, policy: pol};
    return {
      root: s(tree.root), asp_root: s(asp.root), vendor_root: s(vendors.root), vendor_checked: true,
      nullifiers: arr([nullifier(nk, noteCommitment(n0), 0n), nullifier(nk, noteCommitment(dummy), 5n)]),
      budget_nullifier: s(nullifier(nk, budgetCommitment(b), 1n)),
      change_commitment: s(noteCommitment(change)), new_budget_commitment: s(budgetCommitment(nb)),
      refund_core: s(noteCore(FIX.label, noteInner(owner, 13n, pol))),
      amount: s(amount), fee: s(fee), token: s(FIX.token), recipient: s(FIX.merchant), now: s(FIX.now), context: s(FIX.context),
      sk: s(FIX.sk), label: s(FIX.label), asp_index: s(aspIdx), asp_path: arr(asp.path(aspIdx)), policy_params: policyInput(POLICY),
      in_amounts: [s(n0.amount), "0"], in_blindings: ["7", "8"], in_indices: ["0", "5"], in_paths: [arr(tree.path(0)), arr(tree.path(5))],
      budget_remaining: s(b.remaining), budget_period: s(period), budget_blinding: "9", budget_index: "1", budget_path: arr(tree.path(1)),
      vendor_level: "3", vendor_categories: s(0b010n), vendor_expiry: s(expiry), vendor_index: "1", vendor_path: arr(vendors.path(1)),
      change_blinding: "11", new_budget_blinding: "12", refund_blinding: "13",
    };
  }
  if (name === "budget_init") {
    const period = FIX.now / POLICY.periodSeconds;
    const cm = budgetCommitment({remaining: POLICY.periodBudget, period, owner, blinding: 5n, policy: policyHash(POLICY)});
    return {
      budget_commitment_out: s(cm), now: s(FIX.now), context: s(FIX.context),
      admin_sk: s(FIX.adminSk), policy_params: policyInput(POLICY), agent_owner: s(owner), blinding: "5",
    };
  }
  if (name === "ragequit") {
    const n = {amount: 50_000000n, token: FIX.token, label: FIX.label, owner, blinding: 7n, policy: 0n};
    tree.insert([5n, noteCommitment(n)]);
    return {
      root: s(tree.root), nullifier: s(nullifier(nk, noteCommitment(n), 1n)), amount: s(n.amount), token: s(FIX.token), label: s(FIX.label),
      sk: s(FIX.sk), blinding: "7", policy: "0", leaf_index: "1", path: arr(tree.path(1)),
    };
  }
  throw new Error(`no fixture for ${name}`);
}
