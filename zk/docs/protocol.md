# Protocol specification

This is the exact spec the code implements. The single source of truth for hashes is
`circuits/lib/src/lib.nr`. `contracts/src/libraries/ShieldedHashes.sol` and `client/src/hashes.ts`
mirror it. `test-vectors/vectors.json` (printed by Noir) is asserted by the Solidity and TS test
suites, so if the three implementations ever diverge, the tests fail.

## 1. Field and hash

- Field: BN254 scalar field, `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Hash: Poseidon2, t=4, rate 3, Rf=8, Rp=56 (the Barretenberg/Noir parameters).
  - Noir side: [noir-lang/poseidon](https://github.com/noir-lang/poseidon) v0.4.0 `Poseidon2::hash`.
  - EVM side: [zemse/poseidon2-evm](https://github.com/zemse/poseidon2-evm) v2.0.0, vendored at commit `30c6986`.
- **Every protocol hash takes 2 or 3 inputs.** For `n ∈ {2,3}`, `Hn(x..) = permute([x0, x1, x2|0, n·2^64])[0]`, which is
  exactly one permutation.
  - This is deliberate. The EVM library only exposes single-permutation hashes, and keeping every
    hash to one permutation keeps the on-chain cost at one permutation per hash.
  - Verified: Noir `h2(0,0) = 0x0b63a537…56f1`, which equals poseidon2-evm's own test vector.
- Domain tags are small integers placed in the first slot:

| tag | value | object |
|---|---|---|
| NK | 1 | nullifier key |
| OWNER | 2 | owner public key |
| NOTE | 3 | note core |
| NULL | 4 | nullifier |
| BUDGET | 5 | budget-note core |
| POLICY | 6 | policy hash |
| ADMIN | 7 | admin public key |
| VENDOR | 8 | verified-vendor leaf |

Merkle nodes are the only untagged hash: `node = H2(left, right)`. Empty leaves are 0.
`zeros[i+1] = H2(zeros[i], zeros[i])`. All three trees have depth 20.

## 2. Keys (client/src/keys.ts)

```
seed (32+ bytes, one backup)
  sk       = HKDF-SHA256(seed, info="grayr.zk.v1.sk.<account>", 64 bytes) mod p    spending key
  nk       = H3(NK, sk, 0)                                                       nullifier key
  owner    = H3(OWNER, sk, 0)                                                    owner public key
  viewPriv = HKDF(seed, "grayr.zk.v1.view.<account>", 32)   X25519               decrypts incoming notes
  adminSk  = HKDF(seed, "grayr.zk.v1.admin", 64) mod p ; adminPk = H3(ADMIN, adminSk, 0)
agent i  = account 1_000_000 + i (derived from the HUMAN's seed, so the human can always recover it)
address  = "zk1" ‖ owner (32B hex) ‖ viewPub (32B hex)
```

Why `nk` is separate from `owner`: whoever holds `nk` can compute the nullifiers of your notes,
and therefore see when they are spent, but cannot spend them, because spending needs `sk`.
This is the Zcash "nullifier deriving key" idea, simplified.

## 3. Notes

```
inner      = H3(owner, blinding, policy)              policy = 0 for unrestricted notes
core       = H3(NOTE, label, inner)
commitment = H3(amount, token, core)                  amount < 2^128, token = ERC-20 address

budget note: bcommit = H3(remaining, period, H3(BUDGET, 0, H3(owner, blinding, policy)))

nullifier  = H3(NULL, nk, H2(commitment, leafIndex))
```

- **Why `label` sits inside `core`:**
  - At deposit the contract assigns the label, so it must compute `core` and the commitment
    itself. The user sends only `inner`, which hides the owner, blinding and policy.
  - Swaps and Path-B refunds need the contract to *materialize* a note whose amount (and token)
    are only known on-chain: `commitment = H3(amountOut, tokenOut, core)`, where `core` comes from
    the proof. Because `core` includes a random blinding, it does not reveal the label.
- **Why `leafIndex` is in the nullifier.** Two identical commitments at different leaves (two
  equal deposits) are both spendable. Without the index, a "faerie gold" attack becomes possible:
  someone sends you the same note twice, you think you got paid twice, and only one copy is spendable.
- **Encryption** (client/src/notes.ts):
  - ECIES with X25519 + HKDF-SHA256 + ChaCha20-Poly1305: `ct = ephPub(32) ‖ AEAD(...)`.
  - A note is accepted only if the decrypted fields recompute the on-chain commitment, so a junk or
    malicious ciphertext can never create a phantom balance.
  - Deposits carry `label = 0` in the ciphertext. Deferred outputs carry `amount = 0`. The wallet
    fills these in from on-chain events (`Deposited`, `Swapped`, `TransferAuthorized` /
    `AuthorizationReclaimed`) before checking the commitment.

## 4. Labels and lineage (Privacy Pools model)

- `label = keccak256(abi.encode(keccak256("grayr.zk.label.v1"), chainId, pool, depositCount)) mod p`.
  It is assigned on-chain at deposit, and the contract records `depositorOf[label] = msg.sender`.
- **Every note in a transaction must carry the same label**, and outputs inherit it. That is how a
  deposit's clean or excluded status survives arbitrarily many spends, change notes and swaps.
- Consequences (documented in privacy.md):
  - Notes from two different deposits cannot be merged in one spend.
  - A private-transfer recipient learns which deposit their note descends from.

## 5. Circuits and their public inputs (in verifier order)

| circuit | public inputs | private witness (summary) |
|---|---|---|
| `transact` | root, aspRoot, nullifiers[2], outCommitments[2], publicAmount, fee, token, recipient, deferred, context | sk, label + ASP path, policy (+ params, adminSk if policy≠0), 2 input notes + paths, 2 output notes |
| `policy_pay` | root, aspRoot, vendorRoot, vendorChecked, nullifiers[2], budgetNullifier, changeCommitment, newBudgetCommitment, amount, fee, token, recipient, now, context | sk, label + ASP path, policy params, 2 inputs, budget note + path, vendor leaf + path, blindings |
| `budget_init` | budgetCommitment, now, context | adminSk, policy params, agent owner, blinding |
| `ragequit` | root, nullifier, amount, token, label | sk, blinding, policy, leaf index + path |

The full statements are in the header comment of each `circuits/*/src/main.nr`. The
constraint-by-constraint audit is in security.md.

### `context`: binding everything else

```
context = keccak256(abi.encode(keccak256("grayr.zk.context.v1"), block.chainid, address(pool), kind,
            feeRecipient, requestId, deadline, keccak(encryptedOutput0), keccak(encryptedOutput1), extra)) mod p
kind:  1 transact · 2 policyPay · 3 budgetInit · 4 authorize (Path B) · 5 swap
extra: authorize → keccak(validAfter, validBefore, nonce); swap → keccak(adapter, tokenOut, minAmountOut, keccak(data))
```

The contract recomputes `context` from calldata, `block.chainid` and `address(this)`, and passes it
to the verifier. A proof is therefore useless on another chain or pool, for another relayer
(fee recipient), for another x402 request, after its deadline, with swapped ciphertexts, or under
another kind of call. `recipient` and `context` appear in no constraint. The Solidity verifier
still binds them, and `contracts/test/Verifiers.t.sol` demonstrates this by flipping each public
input of a real proof.

### Deferred mode (`transact`, `deferred = true`)

`outCommitments[1]` is a note **core**. The circuit excludes out1 from value conservation and
forces its amount to 0. The contract later inserts `H3(amount, token, core)`:

- **Path B refund:** `amount = publicAmount`, same token, inserted only if the EIP-3009
  authorization expires unused.
- **Swap output:** `amount = tokens actually received`, `token = tokenOut`.

`transact()` always passes `deferred = false`, and `authorizeTransfer()` / `swap()` pass `true`,
so a proof can't be moved between modes.

## 6. Contract state machine (ShieldedPool.sol)

Every spend follows the same order: validate public inputs (each `< p`; amounts `< 2^128`;
canonical recipient; known root; valid ASP root; nullifiers distinct and unspent; deadline) →
verify proof → **record nullifiers** → insert commitments (one tree batch) → external transfers.
All entry points are `nonReentrant`.

| function | effect |
|---|---|
| `deposit(token, amount, inner, ct)` | pull tokens (rejects fee-on-transfer by balance delta), new label, insert (cm, 0) |
| `transact` / `transactBatch` | spend 2 notes, insert 2 outputs, pay `recipient` `publicAmount`, pay `feeRecipient` `fee` |
| `payWithPolicy` / `payWithPolicyBatch` | as above via policy_pay; plus vendor root known **and** recipient currently an Active Grayr vendor (live) |
| `initBudget` | insert a budget note; each commitment can be initialized once (no replay) |
| `ragequit` | spend 1 note publicly; pay `depositorOf[label]` |
| `authorizeTransfer` | spend notes into ONE pending EIP-3009 digest (Path B) + change; refund core stored |
| `reclaimAuthorization` | after `validBefore`, if USDC shows the nonce unused: insert the refund note |
| `isValidSignature` | EIP-1271: valid only for pending, open, unexpired digests the pool computed itself |
| `swap` | spend notes, send `publicAmount` to an allowlisted adapter, insert the output note of what was received |

Root history: the last 100 roots are valid (O(1) lookup by sequence number). The ASP root must be
the latest one, or the previous one within a 10-minute grace window. Vendor roots use the same
100-root history, and every vendor leaf carries its own 7-day expiry.

## 7. Trees

- **Note tree** (pool): an append-only incremental tree. Insertions always come in 2-leaf pairs:
  deposits insert `(cm, 0)` and spends insert their 2 outputs. A batch of k pairs is inserted in one
  pass, about `(2k − 1) + (20 − log2(2k))` hashes.
- **ASP tree** (off-chain, root posted on-chain): leaves are approved labels in deposit order.
  Anyone can rebuild it from the published label list.
- **Vendor tree** (`VendorTree.sol`):
  - Leaves are `H3(VENDOR, wallet, H3(level, categories, expiry))`, inserted permissionlessly by
    `publish(vendorId, wallet)`.
  - `publish` reads the vendor's live status, the wallet→vendor binding and the computed level from
    the deployed Grayr `VendorRegistry` / `AttestationRegistry`.
  - Categories are attested by holders of the AttestationRegistry `VERIFIER_ROLE`.
