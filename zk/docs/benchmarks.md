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

> After the `require_verified_vendor` flag was added, `transact` is 9,452 gates (was 9,378) and
> `policy_pay` is 13,160 (was 13,079). The timings and gas below were measured before that
> change. Re-run `npm run bench` for current numbers; the difference is under 1%.

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
- **Recursive aggregation** (one proof for N payments, verified once on-chain): this is the big
  lever for micropayments. Design notes are in future-research.md.
- **A shallower tree** cuts insertion cost linearly. Depth 20 is about 1M leaves (ASSUMPTION: the
  capacity a research deployment needs).
