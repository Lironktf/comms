# Refunds, escrow and batching

Card payments come with refunds and chargebacks. x402 payments today are final: once the
facilitator settles, the money is the merchant's, and a refund means the merchant sending USDC
back to a public address. For a shielded payer there *is* no address to send to. This adds both,
without giving up the payer's privacy.

## The idea: a sealed refund slot in every payment

Every refundable or escrowed payment carries a **refund core**: the core of a note that only the
payer can spend, `core = H3(NOTE, label, H3(owner, blinding, policy))`. Its amount isn't decided
yet. The pool turns it into a real note, `H3(amount, token, core)`, only if and when money comes
back.

- **For plain payments** (`pay`), the refund core is the `transact` circuit's second output in
  *deferred mode*. That is the same mechanism Path-B refunds and swap outputs already use, so the
  circuit needed no change.
- **For agent payments** (`payWithPolicy`), `policy_pay` gained one public output, `refund_core`.
  The circuit forces it to use the **same owner, the same policy and the same deposit label** as
  the agent's notes (+148 gates).
  - Without that constraint an agent could collude with a merchant: pay $100, get "refunded"
    into an unrestricted note, and escape its policy.
  - `client/test/circuits.test.ts` shows the circuit rejecting refund cores with policy 0,
    another owner, or another label.
- **The merchant never learns who paid.** It only knows the payment id (the payment's first
  nullifier) and the x402 request id it served. A refund just inserts a note into the tree; the
  payer's wallet recognises it by decrypting the refund ciphertext bound into the payment.

## Payment modes

A payment's mode and terms (`PayOptions`) are hashed into the proof's `context`, so a relayer
can't turn an escrow into a direct payment, shorten a window, or swap the refund ciphertext.
`RefundsEscrow.t.sol::test_relayerCannotChangePaymentTerms` checks this.

| mode | merchant paid | what can happen later |
|---|---|---|
| `direct` (default) | now | nothing: final, as before |
| `refundable` | now | the merchant may `refund(id, amount)`, partially or fully, up to what was paid. It pulls the funds back from the merchant and inserts the payer's refund note |
| `escrow` | when released or claimed | see below; funds wait in the `PaymentBook` |

### Escrow lifecycle (`PaymentBook`)

```
             releaseEscrow (payer secret)  ──────────────► merchant paid in full
   OPEN ──── claimEscrow after claimableAt (merchant) ───► merchant gets amount − refund, payer gets refund
     │       claimEscrow(refund = amount), any time ─────► full refund (merchant cancels)
     │       expireEscrow after expiresAt (anyone) ──────► full refund
     └─ disputeEscrow before claimableAt (payer secret, only if an arbiter was chosen)
            │
         DISPUTED ── resolveEscrow before expiresAt (arbiter) ► any split
                  └─ expireEscrow after expiresAt ─────────────► full refund
```

- **How the payer acts without revealing itself.** The wallet derives two secrets from its
  spending key and the refund core:
  - `release = keccak("grayr.zk.escrow.release.v1", sk, core)`, and a matching `dispute` secret.
  - The payment commits to `payerAuth = keccak(keccak(release), keccak(dispute))`.
  - Releasing reveals only the release secret, so whoever submits it (a relayer, or any fresh
    address) can't turn it into a dispute.
  - Both secrets can be re-derived from the seed.
- **Agents' escrows stay compliant.** If the payment required a Grayr-verified vendor
  (`vendorChecked`), the merchant must *still* be an Active Grayr vendor when it claims. A vendor
  suspended in the meantime can't collect, and the escrow expires back to the agent (e2e test).
- **Bounds.** Escrows last at most 90 days (`MAX_ESCROW_DURATION`; ASSUMPTION: it covers delivery
  plus dispute windows for API purchases, and real dispute-timing data would overturn it).
- **What a refund doesn't restore.** A refund to an agent restores its *balance* but not its
  *budget*, because the budget counts spending attempts. This is conservative and documented in
  the e2e test.

### Why a separate `PaymentBook` contract

- Adding this to the pool pushed it to 28.6 KB, over EIP-170's 24 KB runtime limit, and lowering
  optimizer runs didn't help (29.1 KB at runs=1).
- So the record-keeping and escrow lifecycle live in `PaymentBook` (5.4 KB). The pool deploys it
  in its own constructor, so the address is fixed and trusted.
- The pool keeps verification, the tree, and one entry point the book can call, `shieldRefund`,
  which inserts `H3(amount, token, refundCore)`.
- The book stores only `keccak(record)` per payment (one storage slot); callers pass the record
  back as emitted in `PaymentRecorded`.
- Escrowed funds sit in the book; every refund goes back through the pool.

## Batching

`pool.batch(transacts, pays, policyPays)` replaces `transactBatch` / `payWithPolicyBatch`:
- **Any mix, one transaction, one tree insertion.** The relayer's batch queue now holds
  every payment kind together (`relayer.ts`).
- **It also helps privacy.** Payments from different payers to different merchants land in one
  transaction.

Measured gas (anvil, real proofs; `npm run bench`, results in `benchmarks/results/server-2026-10-17.json`):

| operation | L2 gas |
|---|---|
| direct pay (transact) | 1,525,769 |
| refundable pay | 1,514,587 (the refund slot isn't inserted until used, so it's slightly cheaper) |
| escrow pay | 1,529,480 |
| policy pay, direct / refundable | 1,534,489 / 1,576,389 |
| merchant refund (partial) | 660,812 (one tree insertion) |
| escrow release / claim in full | 69,994 / 74,359 |
| escrow expiry (refund note) | 646,484 |
| batch of 1 / 2 / 4 / 8, per payment | 1,483,597 / 1,200,857 / 1,059,392 / 989,070 |
| batch of 8 mixed (4 direct + 4 refundable), per payment | 1,004,890 |

**What batching can't fix:**
- Each payment still carries its own ~0.67M verifier call.
- The remaining large lever is **recursive aggregation**: one proof that verifies N payment
  proofs, checked on-chain once.
- Verified: nargo 1.0.0-beta.25's stdlib exposes `std::verify_proof_with_type`, the in-circuit
  verifier this needs. bb 5.2.1's `batch_verify` is for Chonk/IPA proofs, not EVM settlement.
- Now built (local only): `settleAggregated`, see aggregation.md. It covers transact/pay
  payments; `policy_pay` still settles through `batch`. It adds proving time on the relayer
  (~34 s at N=2, ~225 s at N=8), and every payment in a group waits for it.

## Tests

| layer | file |
|---|---|
| contract unit (mock verifier) | `contracts/test/RefundsEscrow.t.sol` (16): partial/full/over refunds, forged records, mode/term validation, relayer term tampering, every escrow path and its time bounds, secret separation, vendor suspension at claim, book/pool access control, mixed batch |
| stateful invariants | `contracts/test/Invariant.t.sol`: random refundable/escrow payments, refunds and settlements alongside the existing actions. The book holds exactly the open escrows, the pool exactly unspent notes + pending authorizations, and an over-refund never succeeds |
| real proofs, verifier | `contracts/test/Verifiers.t.sol`: flipping any of policy_pay's 16 public inputs (incl. `refund_core`) is rejected |
| circuit negatives | `client/test/circuits.test.ts`: refund core with policy 0 / another owner / another label is unprovable |
| e2e (anvil, real proofs) | `client/test/refunds-escrow.e2e.test.ts` (13): refunds found and spent and ragequit to the depositor, release from a stranger's address, claim with partial refund, dispute and arbiter split, expiry, agent refunds stay policy-bound, suspended vendor can't collect, mixed 3-payer batch through a batching relayer, x402 refundable payment refunded by request id, escrow refused when the merchant doesn't offer it |
