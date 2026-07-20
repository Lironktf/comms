# ACTP Trust Assumptions & Governance (MVP)

This document states exactly what you must trust to rely on an ACTP deployment, what each
actor can and cannot do, and how those powers are meant to decentralize over time. It is
deliberately blunt: an infrastructure trust layer that hides its own trust assumptions is
not trustworthy.

## Actors and powers

| Actor | Onchain role | Can do | Cannot do |
|---|---|---|---|
| **Registry admin** | `DEFAULT_ADMIN_ROLE` | Grant/revoke all roles; intended to be a Safe multisig (+ timelock post-MVP) | Steal a vendor's identity, forge attestations, move funds (ACTP never custodies funds) |
| **Guardian** | `GUARDIAN_ROLE` | Suspend / unsuspend / revoke vendors | Alter vendor-owned data (domains, wallets, metadata), mint verification |
| **Pauser** | `PAUSER_ROLE` | Pause registration + vendor mutations (incident response) | Bypass the state machine; guardian actions still work while paused |
| **Upgrader** | `UPGRADER_ROLE` | Authorize UUPS implementation upgrades | Change storage arbitrarily without a deployed, reviewable implementation |
| **Verifier** | `VERIFIER_ROLE` (per attestation type) | Issue/revoke attestations of types they're trusted for | Change vendor identity, self-elevate, affect vendors they haven't attested |
| **Verifier admin** | `VERIFIER_ADMIN_ROLE` | Add/remove verifiers; revoke any attestation; ban a compromised attester in O(1) | Register or own vendors |
| **Vendor owner** | record `owner` | Update own domains/wallets/metadata/endpoint; two-step ownership transfer; self-revoke; sign own metadata (level 4) | Grant themselves verification levels 1–3 or 5; affect other vendors |

Every one of these powers emits an event. There are no silent state changes: the full
history of who did what is reconstructible from the chain log alone (the offchain indexer
is a convenience, never a source of authority).

## What you are trusting, by claim

- **"This wallet/domain belongs to vendor X"** — trust the **VendorRegistry contract** (immutable identity + uniqueness) and, for it to *mean* something, the **verifiers** who attested domain/wallet control. A record with verification level 0 asserts nothing.
- **"Vendor X is a real legal entity"** — trust the specific **verifier** that issued the level-3 (KYB) attestation, and whatever KYB provider stands behind it. You may require attestations from a verifier set *you* choose.
- **"This metadata is authentic"** — trust **math, not us**: the document is re-hashed and compared to the onchain anchor. At level 4 (VendorSigned) you don't even trust the registry operator — the vendor's own key signed the hash.
- **"These contract terms are accurate"** — trust nothing automatically. AI/pattern extraction is labeled `ai_extracted` / `deterministic_parse` with confidence and source quotes; only `merchant_declared` terms anchored onchain by the vendor owner, or `verifier_attested` terms, carry authority.
- **"This risk score is fair"** — trust the **published ruleset** (versioned, deterministic) plus the **signals** fed into it. The score ships with every contributing rule, its weight, and its evidence, and an `inputsSnapshotHash` so you can recompute it yourself.

## Threats the MVP explicitly defends against

Replay of attestations (EIP-712 domain binding + per-verifier nonces + expiry); duplicate
identity/domain/wallet claims (contract-enforced uniqueness); resurrection of a revoked
identity (revocation is terminal, identifiers quarantined); a single compromised verifier
(per-issuer enumeration + O(1) attester ban + consumer-chosen verifier sets); tampered
metadata (hash mismatch is detectable and is itself a risk signal); front-running a
registration (deterministic IDs + verification requirement make a stolen registration
worthless); rogue upgrades/role grants (admin behind multisig, all changes evented). See
`design.md` §5 for the full table.

## What the MVP does NOT defend against (known gaps)

- A **compromised or malicious registry admin multisig** can suspend honest vendors or push a malicious upgrade. Mitigation is procedural (multisig threshold, timelock in Stage 2) and detective (all actions evented; Stage 2 adds a public transparency mirror).
- A **verifier lying within its remit** (attesting a fraud as KYB-passed) is not prevented, only contained and revocable. This is the same trust model as WebPKI certificate authorities.
- **Legal-name collisions** (the EV-certificate lesson): a level-3 attestation proves *a* legal entity exists and controls the record, not that its name isn't confusingly similar to a famous brand. Homograph/lookalike detection is a risk-engine signal, not a hard guarantee.
- **Sybil reputation** (V10, post-MVP): the reputation layer is designed to weight by verification level precisely because unweighted reputation (cf. ERC-8004) is farmable.

## Governance roadmap

- **Stage 1 (this MVP):** single operator; admin is a multisig; verifiers onboarded by the verifier admin; everything evented and auditable; open spec and open-source contracts.
- **Stage 2:** independent verifier organizations with their own keys; consumers pick trusted verifier sets; UUPS admin behind a timelock; a public, append-only transparency mirror of all registry mutations (CT-log analog); community dispute/appeal process for suspensions and risk scores.
- **Stage 3:** verifier accreditation moves to a consortium/foundation (CA/Browser-Forum analog); cross-chain identity mirrors; progressive removal of unilateral admin powers.

The north star: ACTP's durability should come from the verification network, the receipts
corpus, and open standards adoption — never from being the only party who can read or write
the data.
