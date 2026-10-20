/**
 * Recursive-aggregation benchmarks (docs/aggregation.md, docs/benchmarks.md "Recursive aggregation").
 *
 *   npx tsx scripts/bench-aggregation.ts [--runs 5] [--sizes 1,2,4,8] [--wasm-runs 5]
 *
 * Local anvil only, real proofs. For each N it settles the same kind of payments three ways and
 * records, per payment: L2 gas (receipt gasUsed), calldata bytes (tx input), and for the
 * aggregate the aggregator's proving time (native bb, every step) and the added latency:
 *   N = 1        pool.transact                      (today's baseline)
 *   N = 2/4/8    pool.batch (N proofs, one tx)      (today's batching)
 *   N = 2/4/8    settleAggregated (one aggregate proof, one tx)
 * Plus bb.js (wasm) proving time of one aggregate_2 (each tree node is a 2^21 circuit).
 * Writes zk/benchmarks/results/aggregation-<host>-<date>.json.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {arch, cpus, hostname, platform, release, totalmem} from "node:os";
import {join} from "node:path";
import {approve, mintUsdc, startDevnet, ZK_DIR, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {Aggregator} from "../src/aggregator.js";
import {ShieldedWallet, type Bundle} from "../src/wallet.js";
import {submitAggregated, submitBatch, submitBundle, transactPublicInputs, type AggregatableBundle} from "../src/pool.js";
import {shieldedPoolAbi} from "../src/abi.js";
import {witness} from "./fixtures.js";

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const RUNS = Number(arg("--runs", "5"));
const SIZES = arg("--sizes", "1,2,4,8").split(",").map(Number);
const WASM_RUNS = Number(arg("--wasm-runs", "5"));
const USDC = (x: number) => BigInt(Math.round(x * 1e6));

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return {n: s.length, min: s[0]!, median: q(0.5), p95: q(0.95), max: s[s.length - 1]!};
};
const r0 = (x: number) => Math.round(x);

let d: Devnet;
let prover: Prover;
let asp: AspService;
let seed = 1;

async function freshPayers(n: number): Promise<ShieldedWallet[]> {
  const ws: ShieldedWallet[] = [];
  for (let i = 0; i < n; i++) {
    const w = new ShieldedWallet({
      keys: deriveSpendingKeys(new Uint8Array(32).fill(0).map((_, k) => (k === 0 ? seed & 0xff : k === 1 ? seed >> 8 : 7))),
      sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp, aggregatable: true,
    });
    seed++;
    const amount = USDC(10);
    await mintUsdc(d, d.address(1), amount);
    await approve(d, 1, d.deployment.usdc, d.deployment.pool, amount);
    const dep = w.prepareDeposit(d.deployment.usdc, amount);
    const wc = d.wallet(1);
    await d.publicClient.waitForTransactionReceipt({
      hash: await wc.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, amount, dep.inner, dep.encryptedNote], account: wc.account!, chain: d.chain}),
    });
    ws.push(w);
  }
  if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
  return ws;
}

/** n payments (one per fresh payer), each 1 USDC to a merchant + 0.01 fee to the submitter */
async function payments(n: number): Promise<{bundles: AggregatableBundle[]; clientMs: number[]}> {
  const ws = await freshPayers(n);
  const bundles: AggregatableBundle[] = [];
  const clientMs: number[] = [];
  for (let i = 0; i < n; i++) {
    await ws[i]!.refresh();
    const t0 = performance.now();
    const b = await ws[i]!.preparePayment({token: d.deployment.usdc, amount: USDC(1), recipient: d.address(5 + (i % 3)), fee: USDC(0.01), feeRecipient: d.address(3)});
    clientMs.push(performance.now() - t0);
    bundles.push(b as AggregatableBundle);
  }
  return {bundles, clientMs};
}

async function calldataBytes(hash: `0x${string}`) {
  const tx = await d.publicClient.getTransaction({hash});
  return (tx.input.length - 2) / 2;
}

const evmOnly = (b: AggregatableBundle): Bundle => {
  const {recursiveProof: _, ...rest} = b;
  return rest as Bundle;
};

async function main() {
  d = await startDevnet(8625);
  prover = new Prover();
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
  const native = new Aggregator({backend: "native"});
  const submitter = d.wallet(3);
  const results: Record<string, unknown> = {};
  const clientProveMs: number[] = [];

  for (const n of SIZES) {
    const runs: Record<string, number>[] = [];
    for (let r = 0; r < RUNS; r++) {
      const row: Record<string, number> = {};
      if (n === 1) {
        const {bundles, clientMs} = await payments(1);
        clientProveMs.push(...clientMs);
        const t0 = performance.now();
        const s = await submitBundle(submitter, d.publicClient, d.deployment.pool, evmOnly(bundles[0]!));
        row.transactGas = Number(s.gasUsed);
        row.transactCalldata = await calldataBytes(s.hash);
        row.transactSubmitMs = performance.now() - t0;
      } else {
        // today's batching: N EVM proofs in one pool.batch
        const b1 = await payments(n);
        clientProveMs.push(...b1.clientMs);
        const t0 = performance.now();
        const sb = await submitBatch(submitter, d.publicClient, d.deployment.pool, b1.bundles.map(evmOnly));
        row.batchSubmitMs = performance.now() - t0;
        row.batchGasPerPayment = Number(sb.gasUsed) / n;
        row.batchCalldataPerPayment = (await calldataBytes(sb.hash)) / n;
        // aggregation: one proof for all N
        const b2 = await payments(n);
        clientProveMs.push(...b2.clientMs);
        const t1 = performance.now();
        const agg = await native.aggregate(b2.bundles.map((b) => ({proof: b.recursiveProof, publicInputs: transactPublicInputs(b, 31337n, d.deployment.pool)})));
        const t2 = performance.now();
        const sa = await submitAggregated(submitter, d.publicClient, d.deployment.pool, b2.bundles, agg.proof);
        const t3 = performance.now();
        row.aggregateProveMs = agg.totalMs;
        for (const [k, s] of agg.steps.entries()) row[`step${k}_${s.circuit}Ms`] = s.ms;
        row.aggregatedSubmitMs = t3 - t2;
        row.aggregatedEndToEndMs = t3 - t1;
        row.addedLatencyMs = t3 - t1 - row.batchSubmitMs;
        row.aggregatedGasPerPayment = Number(sa.gasUsed) / n;
        row.aggregatedGasTotal = Number(sa.gasUsed);
        row.aggregatedCalldataPerPayment = (await calldataBytes(sa.hash)) / n;
        row.aggregateProofBytes = (agg.proof.length - 2) / 2;
      }
      runs.push(row);
      console.log(`N=${n} run ${r + 1}/${RUNS}:`, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, r0(v)])));
    }
    const keys = Object.keys(runs[0]!);
    results[`N=${n}`] = {runs, stats: Object.fromEntries(keys.map((k) => [k, stats(runs.map((x) => x[k]!))]))};
  }

  // bb.js (wasm) proving time of one aggregate_2: N transact recursion proofs from the fixture
  let wasm: unknown = null;
  if (WASM_RUNS > 0) {
    const w = new Aggregator({backend: "wasm"});
    const inner = [];
    for (let i = 0; i < 2; i++) {
      const wi = witness("transact");
      wi.context = String(5000 + i);
      const p = await prover.prove("transact", wi, "noir-recursive");
      inner.push({proof: p.proof, publicInputs: p.publicInputs});
    }
    const ms: number[] = [];
    await w.aggregate(inner); // warm-up (loads the circuit and SRS)
    for (let r = 0; r < WASM_RUNS; r++) ms.push((await w.aggregate(inner)).totalMs);
    await w.destroy();
    wasm = {circuit: "aggregate_2 (EVM target)", runs: ms, stats: stats(ms)};
    console.log("bb.js aggregate_2 ms:", ms.map(r0));
  }

  const git = execFileSync("git", ["rev-parse", "--short", "HEAD"], {cwd: ZK_DIR, encoding: "utf8"}).trim();
  const out = {
    measured: new Date().toISOString(),
    git,
    machine: {host: hostname(), cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()} ${arch()}`},
    toolchain: {nargo: "1.0.0-beta.25", bb: execFileSync(join(process.env.HOME ?? "", ".bb/bb"), ["--version"], {encoding: "utf8"}).trim(), node: process.version},
    method: "local anvil, real proofs; gas = receipt gasUsed (L2 execution); calldata = tx input bytes; proving = native bb unless noted; " +
      "addedLatency = (aggregate proving + submit) - (pool.batch submit) for the same N; relayer queue window excluded",
    runs: RUNS,
    clientProveMs: stats(clientProveMs),
    results,
    wasmAggregate2: wasm,
  };
  const dir = join(ZK_DIR, "benchmarks", "results");
  mkdirSync(dir, {recursive: true});
  const file = join(dir, `aggregation-${hostname().split(".")[0]}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log("wrote", file);
  await native.destroy();
  await prover.destroy();
  d.stop();
}

await main();
