# Recursive aggregation (rung 1)

One proof covers 2, 4 or 8 payments. The pool verifies it once per batch instead of once per
payment, and the batch posts one ~10.7 KB proof instead of N × 8 KB. Measurements:
[benchmarks.md, "Recursive aggregation"](benchmarks.md#recursive-aggregation-rung-1).

Status: built and tested on a local anvil only (no public deployment).

| N | L2 gas / payment | calldata / payment | aggregator proving (native, median) |
|---|---|---|---|
| 1 (`transact`, today) | 1,488,590 | 9,028 B | — |
| 8 (`batch`, today) | 994,238 | 9,080 B | — |
| 2 aggregated | 902,587 | 6,690 B | 33.9 s |
| 4 aggregated | 531,808 | 3,985 B | 97.6 s |
| 8 aggregated | 325,913 | 2,632 B | 224.5 s |

All measured (5 runs, build server, local anvil); see benchmarks.md for p95, latency and method.

## What gets proven

Every payment is still the same `transact` statement (circuits/transact). Only the way the
pool checks it changes.

1. **Payer.** With `aggregatable: true`, the wallet proves its payment twice from the same
   witness:
   - `-t evm` (keccak transcript): what `transact`, `pay` and `batch` verify.
   - `-t noir-recursive` (Poseidon2 transcript): the form a Noir circuit can verify.
     - It is 458 fields (14,656 B). Both proofs are zero-knowledge.
   The bundle carries both (`recursiveProof`), so a failed aggregation can still settle
   through `batch`.
2. **Aggregator** (the relayer, `client/src/aggregator.ts`). It builds a binary tree of
   aggregation proofs:

   ```
   aggregate_8                       digest = K(d01 || d23)          <- proven -t evm, verified by the pool
     aggregate_4  aggregate_4        d01 = K(d0 || d1), d23 = ...    <- -t noir-recursive
       aggregate_2 x 4               d0 = K(pi_0 || pi_1), ...       <- -t noir-recursive
         transact x 8                pi_i = the 12 public inputs of payment i
   ```

   - **Each level:**
     - verifies two proofs of the level below;
     - pins their verification key;
     - exposes ONE public input, its digest.
   - **K(x):** keccak256 of the 32-byte big-endian words of x, mod p.
   - **For N = 2 or 4:** the top level is proven with `-t evm` directly.
3. **Pool.** `settleAggregated(proof, payments)` runs in `AggregationModule`, reached through the
   pool's fallback. For each payment it runs the same checks as `transact` / `pay`:
   - token known, deadline, field ranges;
   - known root, valid association-set root;
   - nullifiers distinct and unspent, then marked spent;
   - fee recipient;
   - pay mode and refund/escrow record.

   It then rebuilds the digest tree from calldata and verifies the proof once against it. Next
   comes one tree insertion for all outputs. Payouts are netted into one transfer per
   (token, recipient), with a `PublicPayment(requestId, merchant, ...)` event per payment.

### Why the binding holds

- **Inner public inputs bound.** The pool recomputes the digest from the payments it is about
  to settle. Changing any field of any payment after proving changes the digest, so the proof
  fails. That covers amount, recipient, nullifier, fee recipient, deadline, request id,
  ciphertexts and pay options, the last few through `context`. Dropping, adding or reordering
  payments fails the same way.
  - Tests: `contracts/test/Aggregation.t.sol` (tampering, drop, reorder).
- **Only transact proofs enter, and only this tree is built on them.**
  - Each circuit asserts `key_hash == <pinned constant>` for its children.
  - bb's in-circuit verifier constrains `key_hash == hash(vk)`.
    - Source: `ultra_honk/oink_verifier.cpp` at bb v5.2.1, `vk_and_hash->hash.assert_equal(vk_hash)`.
  - So a proof for any other circuit can't be aggregated.
  - `scripts/build-aggregates.sh` recomputes every pinned hash and refuses to build if one is
    stale.
- **Each size has its own key.** An aggregate_2 proof doesn't verify on the 4-payment verifier
  (`Verifiers.t.sol: test_aggregateSizesNotInterchangeable`).
- **Inner proofs are really verified.** The recursion is soundly composed: the outer proof
  carries bb's pairing-point accumulator, and the generated EVM verifier checks it. The tamper
  battery in `Verifiers.t.sol` covers every public input and proof bytes.

### Choices, and their grounding

| choice | grounding |
|---|---|
| bb `noir-recursive` target, `PROOF_TYPE_HONK_ZK` = 6, proof 458 fields, vk 115 fields | primary source: `barretenberg/noir/bb_proof_verification/src/lib.nr` at tag v5.2.1; matches what bb 5.2.1 produced for transact (bb.js log: "12 public inputs and 458 fields") |
| inner proofs are ZK, not `-no-zk` | the inner proof becomes a witness of the aggregator, which is run by a third party (the relayer); a non-ZK proof could leak the payer's witness to it |
| digest = keccak256 mod p | the pool must recompute it per batch: keccak is an EVM opcode (30 + 6 gas/word; 96 words for N=8, about 0.6k gas), while Poseidon2 costs a contract call per permutation (the pool's tree insertion pays ~590k gas for its hashes). In-circuit it is small next to recursion: the node circuit (hashes 64 B, children with 1 public input) is 100,441 gates smaller than aggregate_2 (hashes 768 B, children with 12), an upper bound on the cost of the extra 704 bytes of keccak (measured: 1,488,296 vs 1,588,737) |
| binary tree of 2^21 circuits, not one flat circuit | measured: flat aggregate_2/4/8 = 1,588,737 / 3,239,790 / 6,524,517 gates (2^21 / 2^22 / 2^23). Proving aggregate_2 natively peaks at 2.2 GB RSS (measured). This server has 7.7 GB, ~3.4 GB free. ESTIMATE (memory scales with circuit size): flat N=4 needs ~4.4 GB and flat N=8 ~8.8 GB, so they can't run here. Every tree node is 2^21 |
| sizes 2, 4, 8 only | powers of two keep the tree full; anything else goes through `batch` (relayer: largest chunks first, the remainder to `batch`) |
| module behind a DELEGATECALL fallback | EIP-170: ShieldedPool was 443 B under the 24,576 B limit. `settleAggregated` lives in `AggregationModule` (9,456 B), created by the pool's constructor with the pool's own wiring, so the owner can't swap it (the owner still can't move funds). Shared storage, checks and events live in `ShieldedPoolCore` |
| marking nullifiers before the one verification | within one transaction it is equivalent (a rejected proof reverts everything). It makes a nullifier reused inside the batch fail with `NullifierSpent`, exactly as across batches |
| per-payment `PublicPayment` event, netted transfers | merchants reconcile by `requestId` from events, not from token transfers; netting turns 8 payments to 3 merchants + 1 relayer into 4 transfers (test: `test_netting_oneTransferPerTokenAndRecipient`) |

## Relayer

`Relayer({..., batch: {maxSize: 8, windowMs}, aggregation: {aggregator, prover}})`:

- **Intake.**
  - The usual fee check and `eth_call` simulation.
  - The recursion proof is verified against the public inputs the relayer rebuilds from the
    bundle (`transactPublicInputs`). A mismatched or corrupt recursion proof is refused at
    once, instead of failing an aggregate minutes later.
  - Every nullifier is **reserved** from intake until the bundle settles or fails. A second
    bundle spending a queued note is refused (`nullifier ... is already queued`).
- **Flush** (N bundles or `windowMs`):
  - Every aggregatable bundle is re-simulated first, and one that no longer settles is dropped
    and rejected. Typically its payer spent the note through the escape hatch.
  - The rest is cut into chunks of 8, then 4, then 2.
  - Each chunk is aggregated, simulated and submitted. Everything else goes through
    `pool.batch` as before, with that path's existing one-by-one fallback.
- **Fallback.** It is explicit, never silent. If proving, simulating or submitting a chunk
  fails:
  - the chunk goes to `pool.batch`;
  - `log` gets `aggregation of N failed while <stage>: <reason>; falling back to pool.batch`;
  - each `RelayResult` says `mode: "batch" | "single"` with `fallback: <reason>`.

  Tests: `client/test/aggregation.e2e.test.ts`.
- **Escape hatch.** `transact`, `pay`, `payWithPolicy` and `batch` are unchanged. A payer whose
  relayer stalls submits its own EVM proof.

## Not covered (yet)

- **`policy_pay` (agent payments).** It is a different circuit, with 16 public inputs and its own
  vk. It needs its own leaf circuit (or a mixed leaf with a per-child vk choice) and a
  `PolicyInputs` digest in the module. Agent payments still settle through `batch`.
- **`authorize` (Path B) and `swap`.** They have per-payment side effects (EIP-3009 state,
  adapter calls) and stay per-proof.
- **Proving cost.** It scales linearly with N: about 2N − 1 node proofs of a 2^21 circuit each.
  - The tree's levels could be proven in parallel on separate machines. Leaves could also be
    proven as payments arrive, so only log2(N) levels sit on the critical path.
  - Neither is built: the relayer proves a chunk sequentially after the flush.

## Risks and open questions

- **Double-spend window.**
  - A queued payment's note can still be spent elsewhere while the tree is proven (~225 s at
    N=8): directly by its payer, or through another relayer. The pool stays safe either way,
    since nullifiers are checked on-chain at settlement.
  - The cost falls on the relayer: wasted proving, and one more round trip through `batch`.
  - What's in place:
    - nullifiers reserved at this relayer;
    - a re-simulation before proving;
    - a simulation before submitting;
    - fallback to `batch`, then one-by-one.

    Tests: both double-spend cases in `aggregation.e2e.test.ts`.
  - **Open: griefing.** A payer can deliberately make a relayer burn proving time by spending
    the note elsewhere mid-proof. Each attempt costs the attacker a real on-chain spend
    (~1.5M gas).
    - Not built: relayer-side rate limits or a fee that covers proving.
- **Deadlines and root history (open).**
  - Wallets set `deadline = now + 600 s` by default, and N=8 proving uses ~225 s of that.
  - A proof's root must be among the pool's last 100 roots (`MerkleTree.ROOT_HISTORY`).
  - The relayer does not yet skip aggregation for bundles too close to their deadline. When one
    expires, it fails at simulation and falls back like any other failure.
  - ASSUMPTION: 100 insertions in a few minutes is far above this pool's traffic. Would
    overturn it: a measured insertion rate above ~1 per 2 s.
- **Prover cost at larger N.**
  - Linear: 2N − 1 node proofs of ~33 s each (measured per node).
  - ESTIMATE: N=16 would take ~17 min sequentially, which is too slow for interactive x402.
    - Needs leaf pipelining and parallel nodes (not built).
  - Each node needs ~2.2 GB.
- **Contract size.**
  - ShieldedPool is 24,277 B, 299 B under EIP-170. `settleAggregated` sits in its own module
    (9,456 B); the pool only gained a short DELEGATECALL fallback and one immutable (+144 B).
  - **Observed:** a stale incremental Foundry build compiled the pool inside `Deploy.s.sol` at
    25,331 B (over the limit). A clean build (`forge clean && forge build`) gives 24,277 B in
    both places.
  - Deploy only from a clean build, and check the deployed code size.
  - Further features for the pool must go into a module as well.
- **Verifier gas.** 802,305 per aggregate, the same for N = 2/4/8, vs 666,108 per transact
  (both measured in Verifiers.t.sol). Aggregation pays off from N = 2.
- **Trust surface.**
  - The pool DELEGATECALLs a module it created itself; it is immutable and can't be swapped.
  - The fallback only reaches selectors the pool lacks: `settleAggregated` and the module's
    verifier getters.
  - Calling the module directly reverts (`NotDelegated`).
  - The recursion relies on bb 5.2.1's in-circuit UltraHonk verifier, its pairing-point
    accumulator handling, and the pinned vk hashes. **None of this is audited.**

