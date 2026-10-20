# Benchmarks (M7)

Reproduce with `npm run bench -w zk/client` (add `-- --runs 20`). This writes
`zk/benchmarks/results/<host>-<date>.json` with machine, toolchain and git commit recorded.
**Run it on your MacBook to get the numbers for your resume.** The table below is from the
build server and is labeled as such.

## Methodology

- **Circuit size:** `nargo info` (ACIR opcodes) and `bb gates` (UltraHonk `circuit_size`, which
  drives proving cost). The proving key is padded to the next power of two (transact: 16,384).
- **Proving time:** `Prover.prove` = Noir witness generation (`noir_js`) plus UltraHonk proving
  (`@aztec/bb.js` 5.2.1, `verifierTarget: "evm"`, i.e. keccak transcript + ZK), in Node, 4 threads.
  - Each circuit has a standalone fixture witness (`client/scripts/fixtures.ts`).
  - One warm-up run is discarded (it loads the circuit, SRS and backend); then N timed runs,
    reporting median and p95.
  - Separately, the native `bb prove -t evm` CLI is timed end to end per run (process start
    included), 5 runs after a warm-up.
- **Gas:** `gasUsed` from receipts on a local anvil (default hardfork), measuring the real pool
  with the real optimized verifiers and real proofs (`client/scripts/bench.ts`).
  - Deposits are measured on the 2nd deposit, once tree storage slots are warm.
  - Batches have k independent payers, each paying the same merchant.
  - This is **L2 execution gas only**. On Base every transaction also pays an L1 data fee for its
    calldata (a pay tx carries ~9.6 KB: an 8,000-byte proof plus ciphertexts and inputs).
    Proof bytes are pseudorandom, so they barely compress. The L1 data fee depends on the L1 blob
    base fee at that moment, so we don't quote a dollar figure; measure it on Base Sepolia with
    the receipt's `l1Fee` field.
- **Verifier gas:** isolated in `contracts/test/Verifiers.t.sol`. **Tree insertion:** isolated in
  `contracts/test/MerkleTree.t.sol` (`forge test -vv`).

> **Current numbers (2026-10-17 run, refunds + escrow included):** `transact` 9,452 gates,
> `policy_pay` 13,308 gates (+148 for the refund core). Results are in
> `benchmarks/results/server-2026-10-17.json` and the refund/escrow/batching gas table is in
> refunds-escrow.md. That run used 5 proving runs, so its timings are noisier. The detailed
> tables below are the earlier 10-run measurement (commit dca4509).

## Results: build server (Intel Haswell VM, 4 vCPU, 8 GB, Linux, Node 24.19, nargo 1.0.0-beta.25, bb 5.2.1, commit dca4509, 10 runs)

| circuit | ACIR opcodes | gates | proof bytes | witness ms | prove ms bb.js (median / p95) | native bb prove ms (median) |
|---|---|---|---|---|---|---|
| transact (2-in-2-out) | 435 | 9,378 | 8,000 | 25.1 | 449.7 / 510.0 | 501.3 |
| policy_pay | 748 | 13,079 | 8,000 | 32.5 | 654.2 / 792.5 | 573.7 |
| budget_init | 32 | 3,443 | 7,232 | 2.4 | 220.6 / 245.0 | |
| ragequit | 139 | 4,856 | 7,616 | 8.6 | 367.1 / 495.6 | |
| m0_commitment | 5 | 2,879 | 7,232 | 1.0 | 213.5 / 257.3 | |
| m0_merkle (depth 20) | 125 | 1,588 | 6,848 | 5.8 | 196.4 / 239.5 | |

Native CLI time includes process start and loading the CRS each run; bb.js amortizes those.

| operation | L2 gas |
|---|---|
| deposit | 678,326 |
| transact: pay merchant | 1,525,675 |
| transact: private transfer | 1,461,383 |
| transact: withdraw | 1,500,030 |
| payWithPolicy (agent) | 1,529,610 |
| initBudget | 1,365,971 |
| swap (USDC→WETH, mock router) | 1,567,819 |
| authorizeTransfer (Path B) | 1,561,642 |
| ragequit | 850,533 |
| batch of 1 / 2 / 4 / 8 payments, per payment | 1,479,025 / 1,188,172 / 1,048,677 / 981,014 |

### Live on Base Sepolia (2026-10-17, real receipts)

`client/scripts/testnet*.ts` against the deployed stack; raw rows in
`results/base-sepolia-2026-10-17.json`. L1 gas is the OP-stack receipt's `l1GasUsed`: the
data-availability footprint, which is what carries over to mainnet. Sepolia's L1 fee itself
(~3×10⁸ wei per payment) doesn't.

| operation | L2 gas | L1 gas (DA) |
|---|---|---|
| deposit (first / later) | 1,092,228 / 692,890 | 4,618 |
| initBudget | 1,365,947 | 97,021 |
| pay, refundable | 1,525,456 | 113,912 |
| pay, escrow | 1,537,180–1,543,158 | 114,648 |
| payWithPolicy (agent, refundable slot) | 1,545,430 | 117,124 |
| x402 shielded payment (Path A, via facilitator) | 1,525,831 | 114,688 |
| authorizeTransfer (Path B) + stock USDC `transferWithAuthorization` | 1,590,017 + 85,823 | 114,742 + 2,945 |
| merchant refund | 681,926 | 2,838 |
| escrow release / claim with refund / expire | 80,827 / 678,098 / 660,330 | 4,310 / 3,534 / 3,414 |
| batch of 2 (refundable + policy), total | 2,486,771 | 230,500 |
| association-set root | 64,536–95,936 | ~1,700 |

The first deposit into the pool costs more, most likely because it writes storage slots that are
still zero; later deposits only update them. A batch of 2 saves ~0.58M L2 gas over two separate payments but no L1 gas: each proof
is still posted in full, which only recursive aggregation would remove.

### Where the gas goes (pay merchant, 1.53M)

| component | gas | source |
|---|---|---|
| UltraHonk verification (bb `--optimized`) | ~666k | Verifiers.t.sol (default bb verifier: 2.18M) |
| tree insertion, 2 leaves, depth 20 (20 Poseidon2 hashes at ~24.5k + frontier SSTOREs) | ~590k | MerkleTree.t.sol |
| calldata (~9.6 KB), 2 nullifier SSTOREs, 2 token transfers, events, intrinsic | ~270k | remainder |

### Optimizations taken and measured

1. **bb `--optimized` verifier: 2,183,380 → 669,785 gas** on the same proof. It is also 16.7 KB
   instead of 18.2 KB plus two linked libraries.
2. **One shared Poseidon2 contract**, compiled legacy at 1e6 optimizer runs: 52.7k → 24.5k gas
   per hash. Compiling with via-IR at 200 runs cost 2.15× more. Inlining the hash at every call
   site instead would have made the pool 86 KB, over the EIP-170 limit.
3. **Batch tree insertion:** 2 leaves cost the same ~20 hashes as 1, and a batch of 4 spends
   (8 leaves) costs 1.40M instead of 4 × 0.59M.
4. **Transaction batching:** 29% cheaper per payment at 4, 34% cheaper at 8 (vs. a batch of 1).

### Ideas not taken (yet)

- **The Huff Poseidon2** (14.8k/hash per upstream's own benchmarks; "experimental" upstream)
  would save about 200k per spend.
- **Recursive aggregation** (one proof for N payments, verified once on-chain): built on branch
  `aggregation-spike`. See the next section and aggregation.md.
- **A shallower tree** cuts insertion cost linearly. Depth 20 is about 1M leaves (ASSUMPTION: the
  capacity a research deployment needs).

## Recursive aggregation (rung 1)

One aggregate proof settles N = 2, 4 or 8 payments: `pool.settleAggregated` (design and security
argument: aggregation.md).
- Reproduce: `npx tsx scripts/bench-aggregation.ts --runs 5` (from zk/client).
- Raw rows: `results/aggregation-server-2026-10-20.json`.
- Setup:
  - Local anvil, real proofs, commit 9b1fe11.
  - Same build server as above: Intel Haswell VM, 4 vCPU, 8 GB, Node 24.19, nargo 1.0.0-beta.25,
    bb 5.2.1.
  - 5 runs per N, so the reported p95 is the maximum of 5.
- Workload: each run uses fresh payers paying 1 USDC + 0.01 fee to 3 rotating merchants, the
  same payments as today's paths.

**Everything in this table is measured** (receipt `gasUsed`, tx input length, wall clock).

| N | path | L2 gas / payment (median) | calldata / payment | aggregator proving, native bb (median / p95) | latency added vs `batch` (median) |
|---|---|---|---|---|---|
| 1 | `transact` (today) | 1,488,590 | 9,028 B | — | — |
| 2 | `batch` (today) | 1,199,186 | 9,154 B | — | — |
| 2 | `settleAggregated` | **902,587** | 6,690 B | 33.9 s / 34.5 s | +33.7 s |
| 4 | `batch` (today) | 1,066,749 | 9,105 B | — | — |
| 4 | `settleAggregated` | **531,808** | 3,985 B | 97.6 s / 100.2 s | +96.6 s |
| 8 | `batch` (today) | 994,238 | 9,080 B | — | — |
| 8 | `settleAggregated` | **325,913** | 2,632 B | 224.5 s / 228.1 s | +222.1 s |

- **Versus today:**
  - At N = 8, a payment costs 78% less L2 gas than a single `transact` (1.49M → 0.33M) and 67%
    less than in `batch` of 8 (0.99M → 0.33M).
  - Calldata per payment falls 71% (9,028 → 2,632 B).
  - The ~1.53M figure quoted elsewhere is a refundable `pay`. A plain `transact` measured here is
    1.49M.
- **Total transaction gas:** 1.81M (N=2), 2.13M (N=4), 2.61M (N=8).
  - It breaks down as one aggregate verification (802,305 gas; Verifiers.t.sol, the same for every
    N) plus one tree insertion plus per-payment checks, nullifier writes and events.
  - Transfers are netted per (token, recipient).
- **Aggregate proof:** 10,688 B for every N; the EVM verifier sees 1 public input.
- **Proving:**
  - The tree has 2N − 1 nodes, each a 2^21-gate circuit of ~32–35 s (native).
    - N=8 = 4 × aggregate_2 + 2 × aggregate_4 + 1 × aggregate_8, proven one after another.
  - Peak memory per node: 2.2 GB RSS (measured once with `/usr/bin/time`).
  - bb.js (wasm, 4 threads) for one aggregate_2: median 39.6 s, p95 50.8 s (5 runs). That is
    about 1.2× native.
- **Client cost:** an aggregatable payment is proven twice (EVM + recursion target). Median
  1.05 s, p95 1.24 s per payment (145 payments, bb.js), vs ~0.45 s for the EVM proof alone.
- **Latency:** "latency added" is (aggregate proving + submit) − (`batch` submit) for the same N;
  the relayer's queue window is excluded. It is all prover time. Every payment in the group waits
  for the whole tree, because this rung proves the tree sequentially after the flush (see
  aggregation.md, "Not covered").
- **Circuit sizes:**

  | circuit | gates |
  |---|---|
  | aggregate_2 (2 transact proofs + keccak of 768 B) | 1,588,737 |
  | aggregate_4 / aggregate_8 (tree nodes) | 1,488,296 each |
  | flat 4-proof circuit (not used) | 3,239,790 |
  | flat 8-proof circuit (not used) | 6,524,517 |

  The flat circuits are 2^22 / 2^23 circuits that this server can't prove. See aggregation.md.

**Estimate, not measured: L1 data on Base.**
- Live Sepolia receipts show ~114.6k L1 gas for a ~9.6 KB proof-carrying payment.
- ASSUMPTION: L1 data gas scales with calldata bytes, since proof bytes are pseudorandom and
  barely compress.
- On that assumption, an aggregated payment at N=8 (2,632 B) would carry roughly 30–35k L1 gas.
- To confirm, measure `l1GasUsed` on a Base Sepolia `settleAggregated` receipt (not done: this
  rung is local-only).

