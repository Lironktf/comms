/** Proves every circuit on its standalone fixture witness and writes proof fixtures for the
 *  Foundry verifier tests: zk/contracts/test/fixtures/<circuit>.json */
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {Prover, type CircuitName} from "../src/prover.js";
import {ZK_DIR} from "../src/devnet.js";
import {witness} from "./fixtures.js";

const CIRCUITS: CircuitName[] = ["m0_commitment", "m0_merkle", "transact", "policy_pay", "budget_init", "ragequit"];
const out = join(ZK_DIR, "contracts", "test", "fixtures");
mkdirSync(out, {recursive: true});
const prover = new Prover();
for (const c of CIRCUITS) {
  const p = await prover.prove(c, witness(c));
  if (!(await prover.verify(c, p))) throw new Error(`${c}: proof does not verify offchain`);
  writeFileSync(join(out, `${c}.json`), JSON.stringify({proof: p.proof, publicInputs: p.publicInputs}, null, 1));
  console.log(`${c}: ${(p.proof.length - 2) / 2} bytes, ${p.publicInputs.length} public inputs, prove ${p.timings.proveMs.toFixed(0)} ms`);
}
await prover.destroy();
