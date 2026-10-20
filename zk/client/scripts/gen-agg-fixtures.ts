/** Real aggregate proofs for the Foundry verifier tests: contracts/test/fixtures/aggregate_N.json.
 *  N distinct transact statements (the standalone fixture witness with distinct contexts),
 *  proven with the recursion target, then aggregated.   npx tsx scripts/gen-agg-fixtures.ts 2 4 8 */
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {toHex} from "viem";
import {Prover} from "../src/prover.js";
import {Aggregator, aggregateDigest} from "../src/aggregator.js";
import {ZK_DIR} from "../src/devnet.js";
import {witness} from "./fixtures.js";

const sizes = process.argv.slice(2).map(Number);
const prover = new Prover();
const agg = new Aggregator({backend: (process.env.AGG_BACKEND as "native" | "wasm") ?? "native"});
for (const n of sizes.length ? sizes : [2]) {
  const inner = [];
  for (let i = 0; i < n; i++) {
    const w = witness("transact");
    w.context = String(1000 + i);
    const p = await prover.prove("transact", w, "noir-recursive");
    if (!(await prover.verify("transact", p, "noir-recursive"))) throw new Error("inner proof does not verify");
    inner.push({proof: p.proof, publicInputs: p.publicInputs});
  }
  const r = await agg.aggregate(inner);
  if (r.digest !== aggregateDigest(inner.map((p) => p.publicInputs))) throw new Error("digest mismatch");
  writeFileSync(
    join(ZK_DIR, "contracts", "test", "fixtures", `aggregate_${n}.json`),
    JSON.stringify({proof: r.proof, publicInputs: [toHex(r.digest, {size: 32})], innerPublicInputs: inner.map((p) => p.publicInputs)}, null, 1),
  );
  console.log(`aggregate_${n}: ${(r.proof.length - 2) / 2} bytes, ${(r.totalMs / 1000).toFixed(1)} s`, r.steps.map((s) => `${s.circuit} ${(s.ms / 1000).toFixed(1)}s`).join(", "));
}
await prover.destroy();
await agg.destroy();
