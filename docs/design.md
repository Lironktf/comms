# Agentic Commerce Trust Protocol (ACTP) — Design Document

**Status:** v0.2 (living document) · **Date:** 2026-07-20 · **Scope:** V1–V14 vision; V1–V5 implemented in the MVP

---

## 1. Executive Summary

AI agents can already decide *what* to buy. They cannot reliably decide *whether they should*: whether the merchant is real, whether the agent is authorized, whether the contract terms are acceptable, whether the purchase violates organizational policy. Every payment protocol shipping today — x402, Google AP2, Stripe/OpenAI ACP, Visa TAP, Mastercard Agent Pay — treats these questions as out of scope.

ACTP is the **trust and policy layer that sits above payment rails**. It answers, before money moves:

1. **Who is this merchant?** (Vendor Identity Registry — V1)
2. **How verified are they?** (Graduated verification with signed attestations — V2)
3. **What do they sell and on what terms?** (Structured metadata — V3; Contract Intelligence — V4)
4. **How risky are they?** (Explainable risk scoring — V5)
5. **Is this agent allowed to make this purchase?** (Policy + permissions + delegation — V6–V9)
6. **What happened?** (Receipts and tamper-evident audit — V13)

The analogy set: **DNS** (canonical merchant resolution), **TLS/CA + Certificate Transparency** (proven identity with public auditability), **OPA/Cedar** (policy as code), **IAM** (per-agent permissions and delegation).

The payment protocol is not the innovation. The decision that happens before the payment is.

### Why now (evidence, mid-2026)

- x402 v2 shipped (Dec 2025) and is now governed by the x402 Foundation under the Linux Foundation with Visa, Mastercard, Stripe, Google, AWS, Cloudflare among members. Its discovery layer ("Bazaar", 10k+ listed paid tools) has **explicitly no vetting, reputation, or provider verification**.
- A July 2026 population-scale study found that of ~$50M headline x402 volume, only ~$188k was verifiable as payments to identifiable independent services — the rest largely self-dealing/wash volume. **Any agent economy without a trust layer fills with synthetic and adversarial counterparties.**
- Every rail's spec marks spending limits and counterparty trust as "out of scope" (x402 literally; ACP caps a single cart; card-network agent tokens are rail-bound and coarse).
- Visa announced an Agentic Directory of verified agents *and merchants* (June 2026) — closed, network-centric. The open, rail-agnostic version of that registry does not exist. That is the gap.

---

## 2. Core Principles

1. **Protocol-, wallet-, chain-, and agent-agnostic.** Works whether settlement is x402/USDC, Stripe/ACP, card-network tokens, or protocols that don't exist yet. Chain-specific code is confined to adapters.
2. **Facts, not vibes — and facts separated from scores.** The registry stores *verifiable claims with proofs* (domain control, wallet control, legal entity). Risk scoring is a separate, versioned, explainable layer computed *from* facts. Consumers may replace our scoring with their own; they cannot replace the facts.
3. **Machine-consumed trust.** EV certificates failed because humans ignore UI indicators. Our signals are consumed by software making allow/deny decisions — semantics must be precise, machine-readable, and versioned.
4. **Detection over blind prevention.** Following Certificate Transparency: all registry mutations are evented, auditable, and (long-term) mirrored to transparency logs. Assume verifier compromise; design for auditability and fast revocation, not perfect issuers.
5. **Fail closed.** Unknown vendor ≠ neutral. No record, expired attestation, or unverifiable metadata hash → the safe default is "do not pay without human approval."
6. **Never present uncertain AI output as verified fact.** Every AI-extracted datum carries provenance, confidence, and source references, and is typed differently from merchant-signed or verifier-attested data.
7. **Never custody funds.** ACTP authorizes and audits; it does not hold or move money. This keeps the protocol out of money-transmitter scope and keeps incentives neutral.
8. **Open spec, progressive decentralization.** Formats and interfaces are open from day one; operational centralization (one indexer, one risk engine) is a bootstrapping stage, not the end state.

---

## 3. Architecture Overview

### 3.1 Purchase decision flow (target end-state)

```
Purchase Request (agent)
   │
   ▼
Vendor Resolution ──► onchain VendorRegistry (Base) — canonical identity
   │                     + offchain metadata (hash-verified against chain)
   ▼
Context Assembly (parallel):
   • Verification status (attestations, expiry)     [V2]
   • Merchant metadata (capabilities, jurisdictions) [V3]
   • Contract terms (renewal, cancellation, fees)    [V4]
   • Risk evaluation (explainable rules)             [V5]
   ▼
Policy Evaluation (single pass over assembled context) [V6–V9]
   ▼
Decision: ALLOW │ DENY │ REQUIRE_APPROVAL ──► human approval loop [V8]
   ▼
Payment (x402 / ACP / card rail — out of ACTP scope)
   ▼
Receipt + tamper-evident audit record [V13]
```

**Deliberate refinement of the original linear flow:** verification, risk, and contract intelligence are *inputs assembled in parallel* and fed into **one** policy evaluation — not sequential gates. Sequential gates create ordering ambiguity ("risk passed but policy hadn't seen the contract terms"), multiply latency, and make decisions non-reproducible. One policy evaluation over one immutable context snapshot gives a single, replayable, auditable decision.

### 3.2 Onchain / offchain split

**Canonical identity lives onchain (Base).** The registry contract is the source of truth for: vendor ID, owner, official domains, official wallets, x402 endpoint, verification level, status, metadata hash/URI, contract-metadata hash, and verifier attestations. Rationale:

- **Neutrality & liveness:** no single operator can silently edit or censor identity records; the registry outlives the company.
- **Composability:** onchain consumers (smart accounts, Safe guards, x402 facilitators) can check vendor status/level atomically at payment time.
- **Equivocation resistance:** a contract cannot show different answers to different queriers; this is the property CT logs approximate for WebPKI, obtained natively.

**Everything heavy, mutable, or interpretive lives offchain**, cryptographically linked to the chain:

| Data | Location | Link to chain |
|---|---|---|
| Vendor identity record (ID, owner, domains, wallets, status, level) | **Onchain** | native |
| Verifier attestations (typed, expiring, revocable) | **Onchain** (hash + core fields) | native; EIP-712 signatures verifiable off-chain too |
| Full merchant metadata (V3 JSON document) | Offchain, content-addressed (IPFS) | `keccak256(canonical JSON)` anchored onchain + `ipfs://<cid>` URI (CID = sha2-256 of the same canonical bytes) |
| Contract documents, ToS snapshots | Offchain object store | content hash referenced by contract-metadata hash |
| AI contract summaries (V4) | Offchain DB | derived-from content hash + extractor version recorded |
| Risk signals, scores, rulesets (V5) | Offchain | score records reference onchain state (level, status) at block N |
| Search indexes, analytics, ML | Offchain | none (rebuildable) |

Rules of thumb applied: onchain = small, slow-changing, high-value-of-neutrality, needed atomically at payment time. Offchain = large, fast-changing, privacy-sensitive, interpretive, or rebuildable. **No PII onchain, ever** (domains and corporate names are public by nature; KYB evidence is not — only the attestation that a check passed goes on chain).

**Tension acknowledged (chain-agnostic principle vs. Base-canonical registry):** anchoring the canonical registry to one chain is a pragmatic MVP decision (Base = x402's center of gravity, cheap blocks, Coinbase facilitator support). The mitigation is that the registry's *data model* is chain-neutral (CAIP-style identifiers for wallets, no Base-specific semantics), reads are served via the offchain indexer/API to any consumer, and the design reserves cross-chain mirroring (state proofs / attestation bridges) as a later phase. Alternatives considered:

- *Storing full documents onchain:* rejected — gas cost per byte makes multi-KB JSON absurd, and it buys nothing over a hash anchor plus content-addressed offchain storage.
- *Fully offchain signed registry + transparency log (CT model):* cheapest, most flexible; rejected for MVP because it reintroduces "trust the operator's log" during exactly the phase when we have no reputation, and forfeits onchain composability with x402 settlement.
- *Multi-chain from day one:* maximal neutrality; rejected — synchronization/replay complexity dwarfs MVP value.
- *EAS (Ethereum Attestation Service) as substrate:* mature attestation plumbing on Base; strong candidate, but EAS is a generic pipe — we still need vendor-record semantics, uniqueness, lifecycle, and RBAC in our own contract. We keep our attestation struct EIP-712-compatible so mirroring into EAS schemas later is mechanical.

### 3.3 System components (MVP)

```
contracts/   VendorRegistry.sol        — identity, lifecycle, uniqueness, hashes (V1)
             VerificationManager logic — verifier RBAC, EIP-712 attestations (V2)
backend/     indexer                   — chain events → Postgres (reorg-aware)
             metadata service          — versioned V3 docs, hash integrity (V3)
             contract intelligence     — term extraction w/ confidence + provenance (V4)
             risk engine               — deterministic, explainable, versioned (V5)
             REST API                  — vendors, metadata, terms, risk, attestations
sdk/         TypeScript client         — onchain writes (viem) + API reads + integrity checks
```

The backend is a **view + enrichment layer**: if it burns down, everything except AI summaries and risk history is rebuildable from chain + published metadata documents.

---

## 4. Component Designs

### V1 — Vendor Identity Registry (onchain)

**Problem:** an agent about to pay `0x4f3a…` or `api.acme.com` needs a canonical answer to "who is this?"

**Design.** `VendorRegistry` (UUPS-upgradeable, AccessControl-governed) stores one record per vendor:

- `vendorId` — `bytes32`, deterministic: `keccak256("actp.vendor.v1", normalizedPrimaryDomain)`. Deterministic IDs give free duplicate prevention and offline computability. Vendor identity is **non-transferable between entities** (ERC-8004's transferable-NFT identity enables buying aged reputations — an explicit anti-goal); ownership transfer moves the *controlling key*, not the identity.
- `owner` — controlling address; **two-step transfer** (propose/accept) to prevent fat-finger loss.
- `domains[]` — normalized, globally unique across the registry (first-claim, dispute via governance; see Trust Assumptions).
- `wallets[]` — payout addresses, globally unique (a wallet claimed by two vendors is a fraud signal, so it's a hard constraint).
- `x402Endpoint`, `metadataHash` + `metadataURI`, `contractMetadataHash`, `status` (`Active | Suspended | Revoked`), timestamps.
- Status transitions are a strict state machine: `Active ⇄ Suspended → Revoked` (revocation terminal; revoked IDs and their domains are *not* re-registrable — resurrection of a burned identity is an attack).

Registration is **permissionless** (anyone can register a vendor record for a domain they intend to prove) but worthless until verified — trust comes from V2 attestations, not from being in the registry. This mirrors DNS (registration open) + CA (verification gated) and avoids the cold-start problem of a curated directory.

*Alternative considered — permissioned registration:* prevents squatting but makes the registry a gatekeeper with no legitimacy yet. Squatting is mitigated instead by: domain-verified challenge (V2 Level 1) being required before a record is surfaced as trustworthy, plus governance dispute/suspension powers.

### V2 — Verification (graduated, attested, expiring)

Six levels, stored onchain as both a computed `level` and the underlying attestation set:

| Level | Name | Proves | Method |
|---|---|---|---|
| 0 | Unverified | nothing | — |
| 1 | DomainVerified | control of listed domains | DNS TXT / well-known challenge, attested by verifier |
| 2 | WalletVerified | control of payout wallets | signed challenge from wallet key |
| 3 | LegalEntityVerified | real legal entity behind vendor | KYB check (LEI where available), attested |
| 4 | VendorSigned | vendor cryptographically signs its own metadata | EIP-712 signature by vendor owner key over metadata hash |
| 5 | Audited | third-party audit (security/financial/enterprise) | auditor attestation |

Levels are a **UX projection of an attestation set**, not a strict ladder — the contract computes the level from live (unexpired, unrevoked) attestations, so an expired KYB automatically demotes the vendor. Design lessons encoded: linear ladders lie (a vendor can be wallet-verified but not domain-verified); expiry must be structural, not operational.

**Attestations** are EIP-712-signed statements: `{vendorId, attestationType, level, evidenceHash, issuedAt, expiresAt, verifier, nonce}`. Properties:

- **Verifier RBAC:** only addresses holding `VERIFIER_ROLE` (granted by multisig-compatible admin) can post; each attestation records its issuer forever, so a compromised verifier's issuance is enumerable and mass-revocable.
- **Replay protection:** nonce + registry-address + chain-id in the signed domain; attestations are single-use and bound to this deployment.
- **Expiry + renewal:** every attestation expires (default 365d; KYB shorter); renewal = new attestation; revocation is per-attestation or per-verifier (compromise response).
- **Decentralization path:** multiple independent verifier orgs each with their own keys; the *consumer* chooses which verifiers to trust (policy: "require KYB attested by verifier in {…}"). The registry aggregates; it does not monopolize verification.

### V3 — Merchant Metadata (versioned, hash-anchored)

A versioned JSON document (JSON Schema-validated) covering: categories, payment methods, subscription support, refund capability, recurring billing, API/SaaS/digital/physical goods flags, countries served, tax handling, x402 capability descriptors, contact info. Canonicalized (RFC 8785 JCS) and hashed; the hash is anchored onchain per version. Any consumer can verify: fetch document → canonicalize → hash → compare to chain. A mismatch means the serving infrastructure (ours or the merchant's) is lying, and the document must be treated as untrusted. Merchants may co-sign metadata (V2 Level 4) so integrity doesn't depend on the registry operator at all.

**Content-addressed storage (availability).** Integrity (does this document match the onchain commitment?) is distinct from availability (can I retrieve it at all?). A bare keccak anchor guarantees the former but not the latter — if the serving backend dies, the document is unrecoverable and the anchor commits to nothing fetchable. So the canonical document is stored as an **IPFS raw block** (CIDv1, raw codec, sha2-256) and the onchain `metadataURI` is set to `ipfs://<cid>`. The CID is derived from the content, giving two things at once: retrieval from any IPFS node/gateway (not just our backend), and a second self-verifying integrity check independent of the keccak anchor. The two commitments cover identical canonical bytes: **keccak** is the cheap onchain equality anchor; the **CID** is the availability + retrieval-integrity locator. A fully trustless consumer reads the CID from the onchain URI, fetches from any gateway, and verifies against *both* the content address (the gateway can't tamper) and the keccak anchor (the vendor committed to exactly this document) — never touching the registry operator's API. The backend runs a caching `/ipfs/:cid` gateway as a convenience, not a trusted source. Storage is pluggable: an in-process store for dev/test, a self-hosted Kubo node for production; a pinning service is a drop-in third backend.

Long-term: merchants self-publish at `https://<domain>/.well-known/actp.json` (pattern: OpenID Federation entity statements / Cloudflare signature-agent cards); the registry becomes verifier + cache + index rather than author.

### V4 — Contract Intelligence

Structured commercial terms per vendor/offering: trial length, renewal cadence and price, cancellation method and deadline, refund policy, early termination fees, price-increase clauses, arbitration clauses.

**Provenance is first-class.** Every term carries `source ∈ {merchant_declared, verifier_attested, ai_extracted, deterministic_parse}`, a confidence in [0,1], extractor/ruleset version, and source references (document content-hash + location). API responses segregate `verified` from `extracted` terms; **AI-extracted terms are never surfaced without their confidence and provenance**, and low-confidence extractions are flagged `requires_review`. The ToS snapshot itself is content-hashed; term records are invalidated when the underlying document hash changes (a silent ToS change is itself a risk signal).

*Design lesson (P3P):* machine-readable-terms standards die when merchants have no incentive to publish and consumers don't enforce. Our sequencing: AI extraction bootstraps coverage unilaterally → agents start *making decisions* on these fields → merchants gain a concrete incentive to publish signed, correct terms (better than being judged by our extraction). Extraction is the wedge; merchant-signed terms are the destination.

### V5 — Risk Engine (explainable, deterministic, versioned)

**Not ML in the MVP — a transparent rule engine.** Inputs (signals): verification level, attestation freshness/expiry, domain age, registry age, wallet history (age, mixer proximity — MVP: pluggable provider), sanctions-list presence, phishing reports, security incidents, community reports, metadata inconsistencies (e.g., hash mismatch, domain/metadata disagreement).

Output — always the full explanation, never a bare number:

```json
{
  "vendorId": "0x…",
  "riskLevel": "medium",            // low | medium | high | critical
  "score": 42,                      // 0–100, higher = riskier
  "reasons": [
    {"rule": "attestation.kyb.expired", "weight": 15, "evidence": {"expiredAt": "2026-05-01T00:00:00Z"}},
    {"rule": "domain.age.lt_90d",      "weight": 20, "evidence": {"registeredAt": "2026-06-14T00:00:00Z"}}
  ],
  "rulesetVersion": "1.0.0",
  "evaluatedAt": "2026-07-20T12:00:00Z",
  "inputsSnapshotHash": "0x…"
}
```

Properties: deterministic (same inputs + ruleset ⇒ same score — reproducible for disputes), versioned rulesets (scores are comparable only within a version), hard overrides (sanctions match ⇒ `critical` regardless of arithmetic), and monotone freshness (scores carry evaluation timestamps; consumers set max-age). ML can later *propose* signals, but the decision layer stays explainable — an agent declining a merchant must be able to say exactly why (also our defamation-liability posture: we publish *facts and rule outcomes*, not opinions).

### V6–V14 — cross-rail decision layer (implemented)

This is the defensible core (see `strategy.md`): the neutral, cross-rail control plane that
decides and enforces whether a purchase is allowed, on any rail. Full reference in
`policy.md`; the whole layer runs offchain by necessity — it must span card rails that have no
onchain presence at all, which is exactly why an onchain-only "trust layer" could never be it.

- **V6 Policy Engine:** a purpose-built deterministic evaluator (`backend/src/policy/engine.ts`) with the "Cedar property" — a fixed attribute registry, comparison operators, no loops → total, decidable, fully explainable. Deny-overrides, allow-required, deny-by-default. Stateful aggregates (budgets) are computed by context providers and injected; the engine stays pure. Cedar itself was considered but rejected for the MVP: spending needs injected aggregates Cedar can't express internally anyway, and a purpose-built engine keeps full control of explainability and the money-typed context without a WASM dependency.
- **V6 Budgets:** two-phase **hold/settle**, cross-rail by construction — a `$10k/month` cap draws down a USD card charge and a USDC x402 payment against one normalized limit (FX-normalized, fixed-point), so agents sharing a treasury can't double-spend.
- **V7 Agent Permissions:** policies attach to *principals* (org → department → agent), never to wallets; a wallet is a rail detail.
- **V8 Human Approval:** `REQUIRE_APPROVAL` is a first-class outcome; the enforcement token is minted only on grant; approvals expire (fail closed).
- **V9 Delegation:** attenuated org → dept → agent chains — each hop can only narrow authority (min amount, intersect rails/categories, union denies), with revocation.
- **V10 Reputation:** computed from the settlement corpus, **verification-weighted** so sybil feedback barely moves it (ERC-8004's unweighted reputation is the cautionary tale); kept strictly separate from verified facts.
- **V11 Policy Language:** a readable line form (`deny when risk.level == "critical"`) that compiles to the validated JSON AST — a thin surface, no new semantics.
- **V12 Decision API:** one rail-agnostic `POST /v1/decisions` (plus `/decisions/rail/:rail` adapters for x402/ACP/card/AP2) returning allow/deny/approve + a short-lived Ed25519 **decision token** that any enforcement point (x402 facilitator, card issuer JIT hook, A2A endpoint) verifies before settling — this is what turns policy from advisory into enforced, identically on every rail.
- **V13 Receipts:** per-org keccak256 hash chain over every decision/approval/settlement; tamper-evident and verifiable end to end. Periodic Merkle roots anchored onchain is a later stage.
- **V14 Discovery:** query the registry for verified, low-risk merchants instead of searching the open web; ranking is deterministic (verification → inverse risk → reputation) with **no pay-for-placement input** — the moment ranking is buyable, neutrality (the whole value) is gone.

**Cross-rail is the non-negotiable spine.** Each rail's native request is normalized by an
adapter into one `PurchaseRequest`; one policy evaluates it; one signed token enforces it.
Adding a rail is adding an adapter — nothing downstream changes. No single incumbent (Visa,
Mastercard, Stripe) can offer this because each is scoped to its own network; that neutrality
is the moat (`strategy.md`).

---

## 5. Security & Threat Model (MVP scope)

| Threat | Vector | Mitigation |
|---|---|---|
| Vendor impersonation | register lookalike domain (`acme-pay.com`) | domain verification proves control, not legitimacy → risk engine (domain age, metadata inconsistency) + level-3 KYB for high trust; homograph normalization on domains |
| Identity squatting | register someone else's domain first | record is untrusted until domain-verified; governance suspension + dispute path |
| Attestation replay | resubmit old/foreign signature | EIP-712 domain separation (chain id + contract addr), per-verifier nonces, expiry |
| Compromised verifier | malicious attestations at scale | per-issuer enumeration, mass-revoke by issuer, verifier-set governance behind multisig-compatible admin; consumers can distrust a verifier unilaterally |
| Malicious metadata | poisoned JSON, oversized docs, hash games | schema validation, canonicalization before hashing, size caps, integrity check on every read; mismatch ⇒ untrusted + risk signal |
| Front-running registration | mempool sniping of a registration | deterministic vendorId from domain + domain-verification requirement makes stolen registrations worthless; commit-reveal deliberately rejected as UX cost > residual risk |
| Unsafe upgrades/admin | rogue upgrade or role grant | UUPS behind admin role intended for a Safe multisig + timelock; all role changes evented; trust assumptions documented |
| Invalid state transitions | revive revoked vendor, re-register burned domain | explicit state machine enforced in contract; revoked = terminal; domains of revoked vendors quarantined |
| Wash-trading reputation (future) | self-dealing volume to build trust | reputation layer weights by counterparty verification level; receipts corpus analyzed for cluster self-dealing |

**Trust assumptions (MVP, explicit):** registry admin (multisig) can suspend vendors, manage verifiers, and upgrade contracts — documented as a bootstrapping-phase power with a public event trail and a roadmap to timelock + decentralized governance. Verifiers are trusted within their attestation type only. The backend is trusted for *freshness*, never for *integrity* (integrity is always checkable against chain).

---

## 6. x402 Integration

x402 v2 tells an agent *how much* and *where* to pay (`PaymentRequirements`: scheme, network, amount, asset, `payTo`) and settles via facilitator `/verify` + `/settle`. It deliberately says nothing about who the payee is or whether the payer should proceed — and budget management is explicitly out of scope in the spec.

ACTP integration points (in order of shipping):

1. **Pre-payment lookup (MVP):** SDK resolves `payTo` wallet / endpoint domain → registry record + risk score before the agent signs the payment payload. Unknown wallet ⇒ fail closed.
2. **Facilitator middleware:** a facilitator consults ACTP during `/verify` and refuses settlement without an ACTP decision token — the natural enforcement point.
3. **x402 v2 `extensions`:** merchant advertises its ACTP `vendorId` inside `PaymentRequired.extensions`; agent verifies the claimed ID actually lists that `payTo` wallet onchain (the binding is checked, never trusted).

ACTP stays a *layer above*, not an x402 extension-only project: the same registry record and risk score serve ACP (Stripe/OpenAI), AP2 mandate verification, and card-rail JIT issuance. x402 is the first adapter, not the architecture.

---

## 7. Governance & Registry Philosophy

Bootstrapping honestly: **Stage 1 (now)** — single operator, multisig admin, everything evented and auditable; open spec. **Stage 2** — independent verifier organizations with their own keys; consumers choose trusted verifier sets; public transparency mirror of all registry mutations. **Stage 3** — verifier accreditation moves to a consortium/foundation (CA/Browser-Forum analog with CT-style logs); cross-chain mirrors; community dispute process. The registry's defensibility is the verification network + receipts corpus + policy adoption, not data hoarding — the spec being open is what makes it infrastructure.

## 8. Known Weaknesses / Open Questions

- **Two-sided cold start:** merchants won't register for absent agents; agents won't check an empty registry. Wedge: unilateral coverage (we register + verify top x402/API merchants ourselves via public evidence) and buyer-side value first (risk engine works on unregistered wallets/domains too).
- **Incumbent capture:** Visa's closed directory or a Stripe-bundled "good enough" trust check could freeze the market. Our bet: the open, cross-rail layer wins the long tail card networks won't serve.
- **Score liability:** publishing "high risk" invites disputes — hence facts/rules/evidence architecture and an appeals path.
- **Base dependency:** documented above; revisit at Stage 3.
- **Latency:** payment-time decisions need sub-100ms answers → indexer + cache, never on-path chain reads.

## 9. MVP Deliverables Map

| Requirement | Where |
|---|---|
| V1 registry (register/update/transfer/suspend/revoke/lookup/dedupe) | `contracts/src/VendorRegistry.sol` |
| V2 verifier RBAC, EIP-712 attestations, expiry/renewal/revocation | `contracts/src/VendorRegistry.sol` (verification module) |
| V3 versioned metadata + onchain hash integrity | `backend/` metadata service + SDK verify |
| V4 term extraction, confidence, provenance | `backend/` contract-intelligence module |
| V5 explainable risk scores | `backend/` risk engine (versioned rulesets) |
| SDK / REST API / indexer / deploy scripts / CI / tests | `sdk/`, `backend/`, `contracts/script/`, `.github/workflows/` |

See `docs/landscape.md` for the competitive/standards research underpinning these decisions.
