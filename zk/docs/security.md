# Security: threat model, constraint audit, test matrix

> Status: research code, **not audited**. Local anvil and testnet only. Two dependencies
> (poseidon2-evm, bb's `--optimized` Solidity verifier) are unaudited upstream.

ZK bugs are silent: an unconstrained value is simply not proven. In a normal program a missing
check produces a wrong answer someone eventually notices. A missing circuit constraint produces a
valid proof of a false statement that every verifier accepts. So this document lists every value
each circuit relies on and the constraint that pins it.

## 1. Adversaries

| adversary | wants | stopped by |
|---|---|---|
| any outsider | spend others' notes | needs `sk`: owner = H3(OWNER, sk, 0) is recomputed in-circuit from sk |
| note owner | double-spend | nullifier is deterministic per (note, leaf) and recorded before any transfer; replays across roots hit the same nullifier |
| note owner | create value | exact u128 conservation; deposits' commitments computed on-chain from the actually-received amount |
| relayer / facilitator / MEV | redirect, alter, replay, steal fee | recipient, amounts, token, fee, fee recipient, request id, deadline, ciphertexts, chain, pool all bound (public inputs + `context`) |
| **the agent itself** | escape its spending policy | policy is inside every note commitment; only `policy_pay` (enforces policy) or `transact` + admin key can spend policy notes |
| agent | forge budget | budget notes come only from `budget_init` (admin key) or 1-for-1 replacement in `policy_pay`; init proofs can't be replayed |
| sanctioned depositor | hide in the crowd | private spends must prove the deposit label is in the current ASP set; ragequit only pays the original depositor, publicly |
| pool owner | rug | owner can only configure tokens/adapters; cannot move, freeze or redirect funds, or pause spends/ragequit; not upgradeable |
| ASP operator | trap honest users | cannot: ragequit ignores the ASP. Can censor private spends of a label (that is its job) |
| Grayr verifier | approve a bad merchant | out of scope (same trust as Grayr V2); revocation is live via the registry status check |

## 2. Constraint audit

For each value: **C** = constrained by the circuit; **P** = public input bound by the verifier
and checked by the contract; **W** = free witness (it doesn't matter what the prover picks, and
the reason is given).

### `transact`

| value | how it's pinned |
|---|---|
| owner of inputs | C: `owner = owner_pk(sk)`, used to compute every input commitment |
| input commitments | C: recomputed from (amount, token, label, owner, blinding, policy) |
| membership | C: `merkle_root(cm, idx, path) == root` when amount ≠ 0. `to_le_bits` constrains idx < 2^20. P: root ∈ last 100 roots |
| dummy inputs (amount 0) | W: no membership needed because they carry no value. Their nullifier is still published, but it's unique (random blinding) and only the owner's nk can produce it |
| nullifiers | C: `== H3(NULL, nk(sk), H2(cm, idx))`, `n0 ≠ n1`. P: contract re-checks distinct + unspent + `< p` |
| label | C: one `label` for all inputs/outputs; C: `label ∈ asp_root`. P: aspRoot is latest or in grace |
| amounts | C: typed `u128` (ABI range checks). Field sums ≤ 4·2^128 can't wrap mod p. P: contract re-checks publicAmount, fee `< 2^128` |
| conservation | C: `in0 + in1 == out0 + out1' + publicAmount + fee` (out1' = 0 in deferred mode) |
| outputs | C: `cm0` full commitment; `cm1` full commitment, or core in deferred mode with `out_amounts[1] == 0` |
| policy notes | C: if `policy ≠ 0`: `Policy.hash(params) == policy` and `admin_pk(admin_sk) == params.admin_pk` |
| token | C: inside every commitment; P: contract requires a known token |
| recipient, context | P only (bound, not used in constraints). Proven bound by `Verifiers.t.sol` (flip one bit → reject) |
| deferred | P: `bool` (ABI enforces 0/1); contract passes the value fixed by the entry point |
| out owners / policies / blindings | W: the prover chooses who receives (that's the point of a transfer) |

**Reviewed and acceptable:**
- **A dummy whose fields equal one of the prover's own real notes** produces that note's nullifier
  and burns it. This is self-harm only.
- **Admin-path outputs are unrestricted.** That is intended: the admin is the human owner.

### `policy_pay`

| value | how it's pinned |
|---|---|
| policy | C: `policy = Policy.hash(params)`, used in all 3 input commitments and both outputs, so the agent cannot claim different params than its notes commit to |
| token | C: `params.token == token` and in commitments |
| value inputs | C: as in transact (membership if amount ≠ 0, nullifiers) |
| budget input | C: budget commitment recomputed; membership **mandatory**; nullifier; all 3 nullifiers distinct |
| merchant | C: `vendor_checked == params.require_verified_vendor` (public bit). If set: `vendor_leaf(recipient, level, cats, expiry) ∈ vendor_root`, `level ≥ min`, `expiry ≥ now`, category check if mask ≠ 0. P: if vendorChecked, vendorRoot ∈ VendorTree history and the contract live-checks that the recipient's vendor is Active; else vendorRoot must be 0 |
| caps | C: `0 < amount ≤ max_per_payment`, `fee ≤ max_fee` |
| period | C: `period_now = now / period_seconds` (constrained u64 division), `period_seconds > 0`, `period_now ≥ budget.period` (no rollback) |
| budget math | C: `available = period_now > budget.period ? period_budget : remaining`; `amount + fee ≤ available` (u128, overflow-checked); new budget = available − spend for `period_now` |
| change | C: `sum_in − amount − fee` then `assert_max_bit_size::<128>()`, so a negative result (which wraps to ~2^254) is rejected; same owner/policy/label |
| second output | none: an agent can only move policy funds to a verified vendor (or back to itself as change) |
| `now` | P: contract requires `now ≤ block.timestamp` and `block.timestamp − now ≤ 1 h` |

**Rollover analysis (no double budget):**
- Exactly one budget note is consumed per payment, and exactly one successor is created, so a
  budget lineage never forks.
- Rolling over requires `period_now > budget.period`, and `now` can't be in the future, so no
  pre-spending of future periods.
- With `now` up to 1 h stale, an agent can spend the rest of period N during the first hour of
  N+1, and then roll over. Per calendar window that is at most what the policy already allows.
- **Forged budgets** need either the admin key (budget_init) or a commitment in the BUDGET domain,
  which no other circuit and no deposit can produce.

### `budget_init`

- **Pinned by the circuit:** `admin_pk(admin_sk) == params.admin_pk`; `period = now / period_seconds`;
  the commitment holds exactly `period_budget`.
- **Checked by the contract:** each commitment is accepted only once (a replay would insert the
  same commitment at a new leaf, i.e. a second spendable budget), the timestamp is fresh, and
  `context` binds chain, pool and deadline.

### `ragequit`

- **Pinned by the circuit:** ownership, membership and nullifier. `amount`, `token` and `label`
  are public.
- **Checked by the contract:** `depositorOf[label] ≠ 0` and it is the only payee. The ASP is not
  required, by design.

## 3. Contract checklist

| requirement | where |
|---|---|
| bind recipient/amount/token/fee/fee recipient/request id/chain/pool | public inputs + `_context` |
| reject non-canonical field elements (x + p aliasing → double spend) | `_checkField` on every nullifier/commitment/inner; verifier also checks `< p` |
| bounded root history, reject unknown roots | `MerkleTree.isKnownRoot` (100), ASP latest+grace, vendor tree history |
| nullifiers recorded before external transfers | `_verifyTransact` / `_verifyPolicy` write nullifiers, then insert, then `_payout` |
| reentrancy | `nonReentrant` on every external mutating function |
| token allowlist, no fee-on-transfer/rebasing | `configureToken`; balance-delta check at deposit and swap |
| events for tree sync | `NewCommitment`, `NewNullifier`, `Deposited`, `TransferAuthorized`, `AuthorizationReclaimed`, `Swapped` |
| EIP-1271 only for self-computed digests | `authorizeTransfer` computes the FiatToken TransferWithAuthorization digest itself; never accepts a raw hash |
| Path B single use / no double refund | USDC nonce (single use) + `closed` flag; refund requires `now ≥ validBefore` (USDC requires `<`) and `authorizationState == false` |
| swap can't be stolen by the adapter | pool measures received `tokenOut`; `≥ minAmountOut` bound in the proof; whole tx reverts otherwise |
| owner powers minimal | only `configureToken`, `setSwapAdapter`; known tokens can never be un-known (notes stay spendable) |

## 4. Test matrix (all passing; see README for commands)

| layer | tests |
|---|---|
| Noir unit | `nargo test --workspace`: hash vectors, Merkle index range, M0 negatives, transact (ok, overspend, wrong secret, unapproved label) |
| shared vectors | Noir prints → `vectors.json` → asserted in `Hashes.t.sol` and `client/test/hashes.test.ts` |
| verifiers (real proofs) | `Verifiers.t.sol`: each circuit's honest proof verifies; **every single public input** flipped → rejected; proof bytes flipped → rejected; wrong input count; cross-circuit proof |
| pool unit | `ShieldedPool.t.sol` (19): every pre-proof revert, payments, batch atomicity, replay, ASP grace, ragequit, budget replay, Path B lifecycle with FiatToken semantics, root window |
| invariants | `Invariant.t.sol`: random deposits/spends/replays/ragequits/authorizations/settlements/refunds with a sound mock verifier: **pool balance == unspent notes + pending authorizations**, no replay ever succeeds, tree aligned. 1024 calls, 0 reverts |
| tree | `MerkleTree.t.sol`: differential fuzz of batch insertion vs naive full recomputation |
| real USDC | `PathBFork.t.sol` on local forks of Base Sepolia and Base mainnet: the real FiatToken accepts the pool's EIP-1271 authorization and rejects anything else |
| e2e (anvil, real proofs) | pool (24), policy (15), x402 Path A + B (6), swaps + batching (5): wrong secret, tampered recipient/amount/fee/fee recipient/request id/deadline/ciphertext/commitment/nullifier/token, stale/unknown roots, non-canonical nullifier, garbage proof, front-runner, over-cap, over-fee, over-budget, unverified/low-level/wrong-category merchant, suspended vendor, policy bypass via transact, forged admin, budget replay, ASP exclusion, ragequit, expired Path-B refund |

## 5. Known limitations / not defended

- **Anonymity set.** With few users, timing and amount correlation de-anonymizes. See privacy.md.
- **Swap adapter and token allowlist** are owner-controlled trust assumptions. A malicious adapter
  can sandwich a swap up to the user's own `minAmountOut`, but cannot take more.
- **USDC is centrally controlled.** Circle can blacklist the pool's address (freezing every
  shielded USDC) or upgrade FiatToken (for example to fee-on-transfer). This is the main reason
  association sets are mandatory.
- **Vendor-level demotion lags** by up to the 7-day leaf TTL. Suspension and revocation are instant.
- **Agents can extract up to `max_fee` per payment** by acting as their own relayer. The policy
  bounds this, and it counts against the budget.
- **The policy admin is fully trusted** by construction: it can sweep the agent's funds and mint
  budgets.
- **Upstream components:** UltraHonk soundness rests on Barretenberg. bb 5.2.1 includes the
  October 2026 native-verifier fix, which concerned recursive pairing accumulators. We don't use
  recursion.
