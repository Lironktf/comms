/**
 * M7 benchmarks. Run:  npm run bench -w zk/client   (add -- --runs 20 for more samples)
 *
 * Measures, and writes zk/benchmarks/results/<host>-<date>.json + prints a markdown table:
 *   1. circuit size: ACIR opcodes (nargo info) and UltraHonk gates (bb gates)
 *   2. proving time per circuit: witness generation + proof, bb.js in Node, N runs after 1 warm-up
 *   3. native `bb prove` time per circuit (CLI), for comparison
 *   4. gas (L2 execution gas from receipts, local anvil) for every pool operation, and batched
 *      gas per payment for batch sizes 1, 2, 4, 8
 * Methodology notes are in zk/docs/benchmarks.md. Machine + toolchain + git commit are recorded.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync, readFileSync, mkdtempSync} from "node:fs";
import {cpus, hostname, totalmem, platform, arch, release, tmpdir} from "node:os";
import {join} from "node:path";
import {encodeAbiParameters, type Address} from "viem";
import {Prover, type CircuitName} from "../src/prover.js";
import {witness} from "./fixtures.js";
import {approve, increaseTime, mintUsdc, registerVerifiedVendor, startDevnet, ZK_DIR, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {AgentWallet, prepareBudgetInit, ShieldedWallet, type Bundle} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash} from "../src/hashes.js";
import {claimEscrow, expireEscrow, merchantRefund, submitBatch, submitBundle, submitEscrowRelease, submitRagequit} from "../src/pool.js";
import {shieldedPoolAbi} from "../src/abi.js";

const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 10;
const SKIP_GAS = process.argv.includes("--no-gas");
const HOME = process.env.HOME ?? "";
const BIN = {nargo: join(HOME, ".nargo/bin/nargo"), bb: join(HOME, ".bb/bb")};
const CIRCUITS: CircuitName[] = ["transact", "policy_pay", "budget_init", "ragequit", "m0_commitment", "m0_merkle"];

const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {n: s.length, min: s[0]!, median: q(0.5), p95: q(0.95), max: s[s.length - 1]!};
};
const round = (x: number) => Math.round(x * 10) / 10;

async function circuitSizes() {
  const out: Record<string, {acirOpcodes: number; gates: number}> = {};
  const info = JSON.parse(sh(BIN.nargo, ["info", "--workspace", "--json"], join(ZK_DIR, "circuits")));
  for (const c of CIRCUITS) {
    const pkg = info.programs.find((p: {package_name: string}) => p.package_name === c);
    const acir = pkg.functions.find((f: {name: string}) => f.name === "main").opcodes;
    const gates = JSON.parse(sh(BIN.bb, ["gates", "-b", join(ZK_DIR, "client/artifacts", `${c}.json`)])).functions[0].circuit_size;
    out[c] = {acirOpcodes: acir, gates};
  }
  return out;
}

async function provingTimes() {
  const prover = new Prover();
  const out: Record<string, {witnessMs: ReturnType<typeof stats>; proveMs: ReturnType<typeof stats>; proofBytes: number}> = {};
  for (const c of CIRCUITS) {
    const w = witness(c);
    const warm = await prover.prove(c, w); // warm-up: loads circuit, SRS, backend
    const wit: number[] = [], prv: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const p = await prover.prove(c, w);
      wit.push(p.timings.witnessMs);
      prv.push(p.timings.proveMs);
    }
    out[c] = {witnessMs: stats(wit), proveMs: stats(prv), proofBytes: (warm.proof.length - 2) / 2};
    process.stdout.write(`  proved ${c} x${RUNS}: median ${round(stats(prv).median)} ms\n`);
  }
  await prover.destroy();
  return out;
}

async function nativeProvingTimes() {
  // Native CLI: nargo execute (witness) + bb prove -t evm, timed end to end per run.
  const out: Record<string, ReturnType<typeof stats>> = {};
  const dir = mkdtempSync(join(tmpdir(), "zkbench-"));
  for (const c of ["transact", "policy_pay"] as CircuitName[]) {
    const prover = new Prover();
    const w = witness(c);
    const {Noir} = await import("@noir-lang/noir_js");
    const circuit = JSON.parse(readFileSync(join(ZK_DIR, "client/artifacts", `${c}.json`), "utf8"));
    const {witness: wbin} = await new Noir(circuit).execute(w);
    await prover.destroy();
    const wpath = join(dir, `${c}.gz`);
    writeFileSync(wpath, wbin);
    const times: number[] = [];
    for (let i = 0; i < Math.min(RUNS, 5) + 1; i++) {
      const t0 = performance.now();
      sh(BIN.bb, ["prove", "-b", join(ZK_DIR, "client/artifacts", `${c}.json`), "-w", wpath, "-o", join(dir, c), "-t", "evm", "-k", join(ZK_DIR, "client/artifacts", `${c}.vk`)]);
      if (i > 0) times.push(performance.now() - t0);
    }
    out[c] = stats(times);
  }
  return out;
}

async function gas() {
  const d: Devnet = await startDevnet(8690);
  const prover = new Prover();
  const out: Record<string, number> = {};
  try {
    const asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
    const mk = (n: number) => new ShieldedWallet({keys: deriveSpendingKeys(new Uint8Array(32).fill(n)), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    const relay = (b: Bundle) => submitBundle(d.wallet(2), d.publicClient, d.deployment.pool, b);
    const dep = async (w: ShieldedWallet, amount: bigint, opts: {to?: ShieldedWallet["address"]; policy?: bigint} = {}) => {
      await mintUsdc(d, d.address(1), amount);
      await approve(d, 1, d.deployment.usdc, d.deployment.pool, amount);
      const x = w.prepareDeposit(d.deployment.usdc, amount, opts);
      const wc = d.wallet(1);
      const r = await d.publicClient.waitForTransactionReceipt({hash: await wc.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, amount, x.inner, x.encryptedNote], account: wc.account!, chain: d.chain})});
      return Number(r.gasUsed);
    };
    const pub = async () => {
      if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
    };
    const merchant = d.address(4);
    await registerVerifiedVendor(d, {owner: 4, domain: "bench.example", wallet: merchant, level: 3, categories: 1n});

    const a = mk(1), b = mk(2);
    await dep(a, 1_000_000000n);
    out.deposit = await dep(a, 1_000_000000n); // 2nd deposit: warm tree slots, representative
    await pub();
    out.transact_pay = Number((await relay(await a.preparePayment({token: d.deployment.usdc, amount: 5_000000n, recipient: merchant, fee: 10_000n, feeRecipient: d.address(2)}))).gasUsed);
    out.transact_transfer = Number((await relay(await a.prepareTransfer({token: d.deployment.usdc, amount: 50_000000n, to: b.address}))).gasUsed);
    out.transact_withdraw = Number((await relay(await a.preparePayment({token: d.deployment.usdc, amount: 1_000000n, recipient: d.address(1)}))).gasUsed);
    out.swap = Number((await relay(await a.prepareSwap({token: d.deployment.usdc, amountIn: 10_000000n, swap: {adapter: d.deployment.swapAdapter, tokenOut: d.deployment.weth, minAmountOut: 1n, data: encodeAbiParameters([{type: "uint24"}], [3000])}}))).gasUsed);
    const now = (await d.publicClient.getBlock()).timestamp;
    const authB = await a.prepareAuthorization({token: d.deployment.usdc, amount: 1_000000n, to: merchant, validAfter: now - 60n, validBefore: now + 600n, nonce: `0x${"11".repeat(32)}`});
    out.authorize_pathB = Number((await relay(authB)).gasUsed);
    await a.refresh();
    const owned = a.valueNotes(d.deployment.usdc)[0]!;
    out.ragequit = Number((await submitRagequit(d.wallet(2), d.publicClient, d.deployment.pool, await a.prepareRagequit(owned))).gasUsed);

    // policy
    const seed = new Uint8Array(32).fill(77);
    const admin = deriveAdminKeys(seed);
    const policy = {adminPk: admin.adminPk, token: BigInt(d.deployment.usdc), maxPerPayment: 100_000000n, maxFee: 1_000000n, periodBudget: 1_000_000000n, periodSeconds: 86400n, minVendorLevel: 1n, categoryMask: 0n, requireVerifiedVendor: true};
    const agent = new AgentWallet({keys: deriveAgentKeys(seed, 0), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp, policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree)});
    await dep(mk(9), 500_000000n, {to: agent.address, policy: policyHash(policy)});
    await pub();
    out.initBudget = Number((await relay(await prepareBudgetInit({prover, admin, policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: (await d.publicClient.getBlock()).timestamp}))).gasUsed);
    out.payWithPolicy = Number((await relay(await agent.preparePolicyPayment({amount: 2_000000n, recipient: merchant}))).gasUsed);

    // refunds + escrow (PaymentBook)
    const payOf = async (w: ShieldedWallet, b: Bundle) => {
      await w.refresh();
      return w.opts.sync.payments.get((b as Extract<Bundle, {kind: "pay" | "policyPay"}>).inputs.nullifiers[0])!;
    };
    const esc = {mode: "escrow" as const, claimAfterSeconds: 3600n, expireAfterSeconds: 86400n};
    const rb = await a.preparePayment({token: d.deployment.usdc, amount: 5_000000n, recipient: merchant, terms: {mode: "refundable"}});
    out.pay_refundable = Number((await relay(rb)).gasUsed);
    out.refund_partial = Number((await merchantRefund(d.wallet(4), d.publicClient, d.deployment.pool, await payOf(a, rb), 1_000000n)).gasUsed);
    const e1 = await a.preparePayment({token: d.deployment.usdc, amount: 5_000000n, recipient: merchant, terms: esc});
    out.pay_escrow = Number((await relay(e1)).gasUsed);
    out.escrow_release = Number((await submitEscrowRelease(d.wallet(3), d.publicClient, d.deployment.pool, a.escrowRelease((await payOf(a, e1)).id))).gasUsed);
    const e2 = await a.preparePayment({token: d.deployment.usdc, amount: 5_000000n, recipient: merchant, terms: esc});
    await relay(e2);
    const e3 = await a.preparePayment({token: d.deployment.usdc, amount: 5_000000n, recipient: merchant, terms: esc});
    await relay(e3);
    await increaseTime(d, 3601);
    out.escrow_claim_full = Number((await claimEscrow(d.wallet(4), d.publicClient, d.deployment.pool, await payOf(a, e2))).gasUsed);
    await increaseTime(d, 86400);
    out.escrow_expire_refund = Number((await expireEscrow(d.wallet(3), d.publicClient, d.deployment.pool, await payOf(a, e3))).gasUsed);
    out.payWithPolicy_refundable = Number((await relay(await agent.preparePolicyPayment({amount: 2_000000n, recipient: merchant, terms: {mode: "refundable"}}))).gasUsed);

    // batches: k independent payers, one tx
    for (const k of [1, 2, 4, 8]) {
      const ws = Array.from({length: k}, (_, i) => mk(100 + k * 10 + i));
      for (const w of ws) await dep(w, 10_000000n);
      await pub();
      const bundles: Bundle[] = [];
      for (const w of ws) bundles.push(await w.preparePayment({token: d.deployment.usdc, amount: 1_000000n, recipient: merchant}));
      const r = await submitBatch(d.wallet(2), d.publicClient, d.deployment.pool, bundles);
      out[`batch_${k}_total`] = Number(r.gasUsed);
      out[`batch_${k}_per_payment`] = Math.round(Number(r.gasUsed) / k);
      process.stdout.write(`  batch ${k}: ${Math.round(Number(r.gasUsed) / k)} gas/payment\n`);
    }
    // mixed batch of 8: 4 direct transact + 4 refundable pay (different payers), one pool.batch
    {
      const ws = Array.from({length: 8}, (_, i) => mk(200 + i));
      for (const w of ws) await dep(w, 10_000000n);
      await pub();
      const bundles: Bundle[] = [];
      for (const [i, w] of ws.entries()) {
        bundles.push(await w.preparePayment({token: d.deployment.usdc, amount: 1_000000n, recipient: merchant, terms: i % 2 ? {mode: "refundable"} : undefined}));
      }
      const r = await submitBatch(d.wallet(2), d.publicClient, d.deployment.pool, bundles);
      out.batch_8_mixed_total = Number(r.gasUsed);
      out.batch_8_mixed_per_payment = Math.round(Number(r.gasUsed) / 8);
    }
  } finally {
    await prover.destroy();
    d.stop();
  }
  return out;
}

const machine = {
  host: hostname(), platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length,
  memGB: Math.round(totalmem() / 2 ** 30), node: process.version,
  nargo: sh(BIN.nargo, ["--version"]).split("\n")[0], bb: sh(BIN.bb, ["--version"]).trim(),
  commit: sh("git", ["rev-parse", "--short", "HEAD"], ZK_DIR).trim(), date: new Date().toISOString(),
};
console.log("machine:", machine);
const result = {
  machine, runs: RUNS,
  circuits: await circuitSizes(),
  provingBbJs: await provingTimes(),
  provingNativeBb: await nativeProvingTimes(),
  gas: SKIP_GAS ? null : await gas(),
};
const dir = join(ZK_DIR, "benchmarks", "results");
mkdirSync(dir, {recursive: true});
const file = join(dir, `${machine.host}-${machine.date.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(result, null, 2));

console.log(`\n### Circuits (${machine.cpu}, ${machine.cores} cores, ${RUNS} runs)\n`);
console.log("| circuit | ACIR opcodes | UltraHonk gates | proof bytes | witness ms (median) | prove ms bb.js (median / p95) |");
console.log("|---|---|---|---|---|---|");
for (const c of CIRCUITS) {
  const s = result.circuits[c]!, p = result.provingBbJs[c]!;
  console.log(`| ${c} | ${s.acirOpcodes} | ${s.gates} | ${p.proofBytes} | ${round(p.witnessMs.median)} | ${round(p.proveMs.median)} / ${round(p.proveMs.p95)} |`);
}
console.log("\nnative bb prove (median ms):", Object.fromEntries(Object.entries(result.provingNativeBb).map(([k, v]) => [k, round(v.median)])));
if (result.gas) {
  console.log("\n### Gas (L2 execution gas, anvil)\n\n| operation | gas |\n|---|---|");
  for (const [k, v] of Object.entries(result.gas)) console.log(`| ${k} | ${v.toLocaleString("en-US")} |`);
}
console.log(`\nwrote ${file}`);
