# Later research (design notes only; nothing here is built)

## Recursive aggregation (biggest lever for micropayments)

Today each payment costs ~666k gas for its own UltraHonk verification. Instead:

- An aggregator proves *"I verified N transact proofs"* in one Noir circuit, using
  `std::verify_proof` with the `noir-recursive` target. The inner proofs must use a
  Poseidon2 transcript, not keccak.
- The circuit outputs the concatenated public inputs, or a hash of them that the contract checks.
- On-chain: one verification (~0.7M gas) plus N × (nullifier writes + transfers), with tree
  insertion batched as today.
- **Cost:** the aggregator's proving time is roughly N × the inner verifier cost (~500k+ gates
  per recursive verification), so this suits facilitators that batch.
- **Note:** the bb 5.2.1 patch concerned native verification of recursive pairing accumulators,
  so pin a version that includes it.

## Shielded receiving (hidden merchant revenue)

Merchants who want private revenue publish a shielded address. Payment then becomes a private
transfer to that address, and the merchant scans ciphertexts with its viewing key. The x402
payload must prove *to the merchant* that a note of X was created for it:

- Option 1: reveal the note opening to the merchant off-chain. The merchant checks that the
  commitment is in the tx.
- Option 2: a dedicated output whose commitment is bound to the request id.

Trial decryption cost grows with pool traffic. Use detection keys (fuzzy message detection) or
tags at scale.

## Rate-limiting nullifiers (anonymous free tiers, anti-abuse)

RLN: each request reveals `y = a0 + a1·x`, with `a1 = H(sk, epoch)` and `x = H(request)`. Two
requests in the same epoch reveal `sk`, and the abuser's stake is slashed. This gives "N free
calls per day per anonymous agent" without accounts, and fits x402 free tiers.

## Escrow notes + zkTLS proof of delivery (x402 refunds)

- Pay into an escrow note: `(merchant, amount, request hash, deadline)`.
- The merchant claims with a zkTLS proof (TLSNotary / Reclaim) that it served a response to that
  request. Otherwise the agent reclaims after the deadline.
- **Open problem:** defining "delivery" for arbitrary APIs.

## ZK receipts for owners and auditors

A proof that *"agent A's payments in period P total ≤ X and all went to level ≥ 3 vendors"*.

- It is computed from the agent's own nullified notes plus the budget lineage, and revealed only
  to the owner or an auditor.
- It composes with Grayr's receipt chain (V13): anchor a commitment of the receipt set on-chain.

## Threshold view keys

See policy-and-compliance.md: k-of-n custodians, a per-transaction escrow ciphertext proven
well-formed in-circuit, and an on-chain request log.

## Private reputation

Merchants accumulate reputation from shielded payments without learning payers. Each payment
emits a blinded "rating token" that is only redeemable once (nullifier) and only by someone who
paid. Unlinkable reputation requires care with timing.

## ZK vs FHE

FHE (e.g. Zama fhEVM) keeps *encrypted balances on-chain*, with no notes or trees. The questions
to benchmark:

- gas per transfer;
- the trust model (the threshold decryption network vs. our "no trusted party");
- composability with public merchants (FHE needs a decryption step to pay a public address);
- privacy against the network itself.

Our model needs no trusted committee, but needs relayers and has anonymity-set limits.

## Other x402 chains

- The pool depends on the EVM, Poseidon2-in-Solidity and an UltraHonk verifier, so it ports to
  any EVM chain with x402 (other L2s).
- Solana would need a different verifier (Groth16/UltraHonk on Solana via syscalls) and a
  different hash cost profile. Grayr's `solana/` registry port is the identity side.
