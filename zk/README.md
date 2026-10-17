# Grayr ZK: private agent payments on Base

**Verified public merchants, private buyers.** AI agents pay x402 APIs from a shielded pool on
Base:

- **The pool pays the merchant directly**, in the same transaction that verifies a
  zero-knowledge proof.
- The public sees "the pool paid M $0.25". It never sees which agent or which owner paid, their
  balance, or their history.
- Merchants receive ordinary USDC in an ordinary wallet. No middleman holds funds.
- The proof also enforces the agent's **spending policy**: Grayr-verified merchant at a minimum
  level, allowed category, per-payment cap, and a private monthly budget. So an agent can be
  trusted with money without anyone seeing its finances.
- **Compliance is part of the core:** Privacy Pools-style association sets and ragequit.
- **Refunds and escrow without unmasking the payer:** every refundable or escrowed payment
  carries a sealed refund slot only the payer can spend. Merchants refund by request id; escrows
  release, get claimed after a window, go to an arbiter, or expire back.
- **Batching:** any mix of payment kinds settles in one transaction and one tree insertion.

Research code. **Local anvil and testnet only. Never mainnet, never real funds. Not audited.**

## Status

| milestone | status | proof it works |
|---|---|---|
| M0 Noir fundamentals: commitment, depth-20 Merkle, bb prove/verify, Solidity verifier on anvil | done | `circuits/m0_*`, docs/learn-zk.md exercises |
| M1 core pool: deposit, 2-in-2-out transfer, pay/withdraw, nullifiers, root history, relayer fee | done | `client/test/pool.e2e.test.ts` (24) |
| M2 x402 Path A: `shielded` scheme, facilitator plugin, relayer, agent pays an x402 API | done | `client/test/x402.e2e.test.ts`, `npm run demo` |
| M3 spending policy: Grayr verified-vendor root with level, caps, category, private budget note | done | `client/test/policy.e2e.test.ts` (15) |
| M4 Path B: USDC EIP-1271 on Base, verified; pool pays an UNMODIFIED x402 merchant | done | docs/path-b.md, `contracts/test/PathBFork.t.sol` (real USDC), x402 e2e |
| M5 compliance: association sets + ragequit | done | pool e2e, `ShieldedPool.t.sol` |
| M6 private swaps + batching | done | `client/test/swap-batch.e2e.test.ts` |
| M7 benchmarks | done (server numbers); **run on your MacBook** | docs/benchmarks.md, `npm run bench -w zk/client` |
| Refunds + escrow + mixed batching | done | docs/refunds-escrow.md, `RefundsEscrow.t.sol` (16), `refunds-escrow.e2e.test.ts` (13), invariants |

Headline numbers (build server, see docs/benchmarks.md):

- `transact` proof: **450 ms** median (9,378 gates).
- Paid x402 call end to end: **~1.45 s**.
- Pay-a-merchant transaction: **1.53M L2 gas**, falling to **0.98M per payment in batches of 8**.
- Verifier: **0.67M gas** (bb `--optimized`; the default verifier costs 2.18M).

## Quick start (local only)

```bash
# toolchain (pinned, verified pair): see docs/deploy.md §0
noirup -v 1.0.0-beta.25 && bbup -v 5.2.1 && foundryup
npm install && (cd zk/contracts && npm install --ignore-scripts)

zk/scripts/build-circuits.sh                       # circuits -> verifiers + client artifacts (deterministic)
(cd zk/contracts && forge build && forge test)     # 52 Foundry tests incl. real-proof verifier tests, invariants
(cd zk/circuits && nargo test --workspace)         # 16 Noir tests
npm run test -w zk/client                          # shared-vector + circuit-negative unit tests
(cd zk/client && npx vitest run --config vitest.e2e.config.ts)   # 65 e2e tests on anvil, real proofs
npm run demo -w zk/client                          # narrated: an agent privately pays x402 APIs
npm run bench -w zk/client                         # M7 numbers for your machine
```

## How it works (one paragraph per piece)

- **Notes.** The pool holds everyone's tokens and a Merkle tree of note commitments
  `H(amount, token, H(NOTE, label, H(owner, blinding, policy)))`. A note lives only on your
  machine; one seed backs up all of them, because notes are rediscovered by trial-decrypting events.
- **Spending.** You prove in zero knowledge that you know the secret of *some* unspent commitment
  in the tree, and publish its nullifier, so it can't be spent twice. Value is conserved:
  inputs = outputs + payment + fee.
- **Binding.** Recipient, amount, token, fee, fee recipient, x402 request id, deadline, chain and
  pool are all bound, so nobody can redirect, replay or alter a payment.
- **Relayers.** A relayer (or the merchant's facilitator) submits the proof and is paid a fee
  from inside it. It learns nothing but what is public anyway.
- **Policies.** The policy hash lives inside the agent's notes. The only circuit that spends them
  without the human's admin key is `policy_pay`, which enforces the policy. The budget is a
  private note, consumed and re-created on every payment.
- **Verified merchants.** Grayr-verified merchants come from `VendorTree`, a Poseidon2 tree
  snapshotting the live Grayr `VendorRegistry` and `AttestationRegistry` with expiring leaves.
  Suspension is enforced live.
- **Path B.** The pool registers one EIP-3009 digest and answers EIP-1271, so a stock x402
  `exact` facilitator moves USDC from the pool to the merchant.

Details: **docs/protocol.md** (spec) · **docs/security.md** (threat model + constraint-by-constraint
audit + test matrix) · **docs/privacy.md** (what is and isn't hidden) · **docs/x402.md** ·
**docs/path-b.md** · **docs/policy-and-compliance.md** · **docs/refunds-escrow.md** · **docs/benchmarks.md** ·
**docs/learn-zk.md** (ZK explained through this code, with exercises) · **docs/deploy.md**
(exact commands for **you** to run) · **docs/future-research.md**.

## Layout

```
zk/
  circuits/          Noir workspace (nargo 1.0.0-beta.25)
    lib/             every hash, key, note, nullifier, Merkle and policy definition (single source of truth)
    transact/        2-in-2-out spend: transfer / pay / withdraw / deferred (Path B, swaps)
    policy_pay/      agent payment with the policy enforced in-proof
    budget_init/     admin mints an agent budget note
    ragequit/        public exit to the original depositor
    m0_commitment/ m0_merkle/   learning circuits
  contracts/         Foundry: ShieldedPool, PaymentBook, VendorTree, AssociationSetRegistry, MerkleTree, adapters,
                     generated verifiers (src/verifiers), mocks, deploy script, tests
  client/            @actp/zk (TypeScript): Poseidon2, keys, notes + encryption, sync, prover (bb.js),
                     ShieldedWallet / AgentWallet, relayer, x402 schemes, ASP, devnet, demo, bench
  test-vectors/      Noir-printed vectors asserted by Solidity and TS
  benchmarks/results/  raw benchmark JSON per machine
  scripts/           build-circuits.sh, rename_verifier.py, gen-abi.mjs
```

## Toolchain (verified, not assumed)

- **nargo 1.0.0-beta.25 + bb 5.2.1.** bbup's version map stops at beta.22, so the pair was
  verified from aztec-packages tag `v5.2.1`, whose `noir/noir-repo` submodule is commit `75061fab`
  = noir tag `v1.0.0-beta.25`. bb 5.2.1 also contains the 2026-10 native-verifier security fix.
- **Poseidon2.** `noir-lang/poseidon` v0.4.0 in-circuit (std only exposes the permutation in
  beta.25); `zemse/poseidon2-evm` v2.0.0 on-chain (vendored, one local `memory-safe` annotation).
- **x402.** `@x402/*` 2.19.0, matching the rest of the repo. The `shielded` server scheme also
  implements the extra fields that 2.28 requires.
- **Placement.** The ZK layer lives in this monorepo as `zk/` (your stated lean). It integrates
  with the Grayr registries by reading them; the deployed Base Sepolia registries need no upgrade.
