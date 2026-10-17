/**
 * Circuit-level negatives for the refund slot (no chain needed). The CLIENT never builds these
 * witnesses; the point is that the circuit itself refuses them.
 */
import {afterAll, describe, expect, it} from "vitest";
import {Prover} from "../src/prover.js";
import {noteCore, noteInner, ownerPk, policyHash} from "../src/hashes.js";
import {FIX, POLICY, witness} from "../scripts/fixtures.js";

const prover = new Prover();
afterAll(() => prover.destroy());

describe("policy_pay refund slot", () => {
  const owner = ownerPk(FIX.sk);
  const pol = policyHash(POLICY);

  it("accepts the honest refund core (same owner, policy, label)", async () => {
    const p = await prover.prove("policy_pay", witness("policy_pay"));
    expect(await prover.verify("policy_pay", p)).toBe(true);
  }, 60_000);

  const evil: [string, bigint][] = [
    ["an UNRESTRICTED note (policy 0): would let a colluding merchant 'refund' the agent out of its policy", noteCore(FIX.label, noteInner(owner, 13n, 0n))],
    ["someone else's note", noteCore(FIX.label, noteInner(ownerPk(0x5678n), 13n, pol))],
    ["another deposit's lineage (label)", noteCore(FIX.label + 1n, noteInner(owner, 13n, pol))],
  ];
  for (const [what, core] of evil) {
    it(`rejects a refund core for ${what}`, async () => {
      const w = {...witness("policy_pay"), refund_core: core.toString()};
      await expect(prover.prove("policy_pay", w)).rejects.toThrow(/bad refund core|Cannot satisfy|constraint/i);
    }, 60_000);
  }
});
