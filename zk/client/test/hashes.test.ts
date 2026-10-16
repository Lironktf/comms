import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {
  adminPk, budgetCommitment, h2, h3, noteCommitment, noteInner, nullifier, nullifierKey, ownerPk,
  policyHash, vendorLeaf,
} from "../src/hashes.js";
import {permute, P} from "../src/poseidon2.js";

const V = JSON.parse(readFileSync(new URL("../../test-vectors/vectors.json", import.meta.url), "utf8"));
const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

describe("Poseidon2 + protocol hashes match the Noir circuits (shared vectors)", () => {
  const sk = BigInt(V.inputs.sk);
  const owner = ownerPk(sk);

  it("h2/h3", () => {
    expect(hex(h2(1n, 2n))).toBe(V.h2_1_2);
    expect(hex(h3(1n, 2n, 3n))).toBe(V.h3_1_2_3);
    expect(hex(h2(0n, 0n))).toBe("0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1");
  });

  it("keys, note, nullifier", () => {
    expect(hex(owner)).toBe(V.owner);
    expect(hex(nullifierKey(sk))).toBe(V.nk);
    expect(hex(noteInner(owner, 999n, 0n))).toBe(V.inner);
    const cm = noteCommitment({amount: 5000000n, token: 0xa0b86991n, label: 77n, owner, blinding: 999n, policy: 0n});
    expect(hex(cm)).toBe(V.commitment);
    expect(hex(nullifier(nullifierKey(sk), cm, 3n))).toBe(V.nullifier);
  });

  it("empty tree root", () => {
    let z = 0n;
    for (let i = 0; i < 20; i++) z = h2(z, z);
    expect(hex(z)).toBe(V.empty_root_20);
  });

  it("vendor leaf, budget, policy", () => {
    const vl = V.vendor_leaf;
    expect(hex(vendorLeaf(BigInt(vl.wallet), BigInt(vl.level), BigInt(vl.categories), BigInt(vl.expiry)))).toBe(vl.value);
    const b = V.budget_commitment;
    expect(hex(budgetCommitment({remaining: BigInt(b.remaining), period: BigInt(b.period), owner, blinding: BigInt(b.blinding), policy: BigInt(b.policy)}))).toBe(b.value);
    const p = V.policy;
    expect(hex(policyHash({
      adminPk: adminPk(BigInt(p.adminSk)), token: BigInt(p.token), maxPerPayment: BigInt(p.maxPerPayment),
      maxFee: BigInt(p.maxFee), periodBudget: BigInt(p.periodBudget), periodSeconds: BigInt(p.periodSeconds),
      minVendorLevel: BigInt(p.minVendorLevel), categoryMask: BigInt(p.categoryMask), requireVerifiedVendor: p.requireVerifiedVendor,
    }))).toBe(p.value);
  });

  it("permutation output is always canonical", () => {
    for (const x of permute([P - 1n, P - 1n, P - 1n, P - 1n])) expect(x < P).toBe(true);
  });
});
