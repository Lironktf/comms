# ACTP — What's Been Built (complete overview)

**Agentic Commerce Trust Protocol** — the trust and policy layer above agentic payment rails.
Agents can decide *what* to buy; ACTP decides *whether they should* — verifying the merchant,
enforcing spending policy, and signing off before a payment settles, on any rail.

This document is the full inventory: every phase, what it produced, and the honest current
state. Deeper detail lives in `design.md` (architecture), `strategy.md` (positioning),
`policy.md` (decision model), `landscape.md` (competitive research), `trust-assumptions.md`.

---

## The two halves

1. **Trust substrate — "who is this merchant?"** A canonical vendor registry with graduated
   verification, structured metadata, contract-terms intelligence, and explainable risk.
   Identity is anchored onchain; heavy/interpretive data lives offchain, hash-linked.
2. **Decision layer — "should this agent pay them?"** A rail-agnostic policy + enforcement
   control plane: one policy, evaluated over verification + risk + contract + budgets, yields
   allow / deny / require-approval and a signed token the rail checks before settling. This is
   the defensible core (see `strategy.md`), and it is chain- and rail-neutral by design.

---

## Phases, in the order they were built

### Phase 1 — Research & design
Three parallel research sweeps (payment protocols; identity/trust standards; policy engines &
competitors), synthesized into `design.md`, `landscape.md`, and a threat model. Key finding
that shaped everything: the payment rails consolidated but deliberately left the trust/policy
slot empty, and the *merchant-side* trust lane is nearly unclaimed.

### Phase 2 — V1–V5 trust substrate
- **V1 Vendor Registry** (`contracts/src/VendorRegistry.sol`) — Solidity, UUPS-upgradeable, on
  Base. Registration, updates, two-step ownership transfer, suspend/unsuspend/revoke with a
  strict state machine (revocation terminal, identifiers quarantined), deterministic vendor
  ids, contract-enforced domain + wallet uniqueness, metadata + contract-hash anchoring.
- **V2 Verification** (`contracts/src/AttestationRegistry.sol`) — verifier RBAC, EIP-712 signed
  attestations (replay-safe, expiring, renewable, revocable), O(1) attester ban, six
  verification levels (0 Unverified → 5 Audited) computed from the live attestation set.
- **V3 Merchant Metadata** — versioned JSON, schema-validated, canonicalized (RFC 8785) and
  keccak256-anchored onchain; integrity re-checked on every read.
- **V4 Contract Intelligence** — term extraction (deterministic + optional Claude LLM) with
  confidence, provenance, and source quotes; AI output never presented as verified fact.
- **V5 Risk Engine** — deterministic, versioned, explainable rules → level + score + reasons +
  evidence + reproducible inputs-snapshot hash, with hard overrides (sanctions/revocation).
- Plus: reorg-aware replayable **event indexer**, **REST API**, **TypeScript SDK**, Foundry
  deploy scripts, and CI.

### Phase 3 — IPFS content-addressing (V3 availability)
Metadata documents stored as IPFS raw blocks (CIDv1); the CID becomes the onchain
`metadataURI`. Availability and self-verifying retrieval no longer depend on our backend —
anyone can fetch from any gateway and verify against both the content address and the keccak
anchor. Pluggable store (in-memory for dev/test, Kubo for prod). The SDK's `getMetadataTrustless`
fetches from a gateway and verifies without touching the operator's API.

### Phase 4 — V6–V14 cross-rail decision layer (the defensible core)
- **V6 Policy engine** (`backend/src/policy/`) — deterministic, total, deny-by-default,
  fully explainable (returns the exact rules + evidence). Plus cross-rail **budgets** with
  two-phase hold/settle: one normalized cap draws down a card charge in USD and a stablecoin
  payment in USDC together (FX-normalized, fixed-point).
- **V7/V9 Principals + delegation** — org → department → agent hierarchy; attenuated delegation
  (each hop can only narrow authority).
- **V8 Human approval** — first-class `require_approval` outcome; the enforcement token is minted
  only on grant; approvals fail closed on timeout.
- **V10 Reputation** — computed from the settlement corpus, verification-weighted (sybil-damped).
- **V11 Policy language** — a readable line form (`deny when risk.level == "critical"`) compiling
  to a validated JSON AST.
- **V12 Decision API + rail adapters** — one rail-agnostic `POST /v1/decisions`; adapters
  normalize x402 / ACP / card / AP2 into one `PurchaseRequest`; Ed25519 **decision tokens** any
  rail's enforcement point verifies before settling.
- **V13 Receipts** — tamper-evident per-org keccak256 hash chain over every decision / approval
  / settlement.
- **V14 Discovery** — query verified, low-risk merchants; deterministic ranking, no
  pay-for-placement.

### Phase 5 — Solana port (`solana/`)
The V1/V2 identity + attestation registry ported to a single Anchor program, so canonical
identity can live on Solana (Superteam ecosystem, better micropayment economics). Native PDA
uniqueness, no EIP-712 (verifiers sign txs directly), verification level computed offchain.
**Written, not yet compiled/run** (the authoring box lacked the ~5 GB toolchain) — full
`anchor test` suite + `cargo` unit tests included; `solana/README.md` has the run commands.

### Phase 6 — Live on Base Sepolia
Deployed both registries (behind UUPS proxies) to Base Sepolia and verified end to end:
registered a vendor onchain, and confirmed the indexer → API stack reads it back off the live
chain. Addresses in `contracts/deployments/base-sepolia.json`.

### Phase 7 — Feature round (F1–F4)
- **F1 x402 enforcement** (`backend/src/rails/x402.ts`) — settle-time guard: a facilitator calls
  `POST /v1/x402/authorize-settlement` and only settles if a valid decision token binds to the
  exact payment (payTo, amount ≤ max, currency, rail, not expired). Turns policy from advisory
  into *enforced*.
- **F2 MCP server** (`mcp/`) — exposes ACTP as agent tools (`actp_resolve_merchant`,
  `actp_get_risk`, `actp_verified_metadata`, `actp_decide`, `actp_discover`) over stdio, so any
  MCP-speaking agent can check a merchant and get a purchase decision with zero integration.
- **F3 Vetted Bazaar** (`backend/src/services/bazaar.ts`) — ingests x402 Bazaar-style listings,
  cross-checks each against the registry + risk + reputation, and serves a filtered, ranked
  `eligibleForAgentPurchase` feed. Occupies the unvetted-discovery gap.
- **F4 agent identity + mandates + KYB** — Web-Bot-Auth-style agent-signature verification and
  AP2-style signed-mandate verification as first-class policy attributes (`agent.verified`,
  `mandate.present`); a pluggable KYB provider (stub + interface) that turns a passed business
  check into an onchain level-3 attestation input.

---

## Current state

**Live:** Base Sepolia deployment (registries + verified end-to-end).
**Built + tested (not deployed live):** the entire backend decision layer, SDK, MCP server.
**Written, not compiled:** the Solana program.

**Tests — 236 total, all passing:**
- Contracts (Foundry): 76 — unit, access-control, signature, fuzz, invariant, upgrade.
- Core (`@actp/core`): 27 — canonical hashing, CID, money, policy language.
- Backend: 107 — services, policy engine, tokens, rails/x402, principals+budgets, decisions,
  approvals, receipts, bazaar, agent-auth, KYB, API integration.
- MCP: 7 — tool handlers against an in-process backend.
- End-to-end: 19 — anvil → deploy → indexer → API → SDK, incl. the cross-rail decision flow.

## Repository map

```
contracts/   Foundry — VendorRegistry + AttestationRegistry (live on Base Sepolia)
solana/      Anchor — the same registry for Solana (written, unbuilt)
packages/core/  shared: canonical hashing, CIDs, money, policy model + language, types, ABIs
backend/     API + indexer + all services (trust substrate + decision layer + F1/F3/F4)
sdk/         TypeScript SDK (onchain + API + trustless verification + decision flow)
mcp/         MCP server exposing ACTP as agent tools
docs/        design · strategy · policy · landscape · trust-assumptions · api · this file
```

## Honest gaps / not done

- **No mainnet, no real users, no company.** Live only on testnet.
- **Solana program is unbuilt** — needs `anchor build && anchor test` on a machine with disk.
- **Enforcement is proven in tests, not wired to a live facilitator** — F1 is the guard; a real
  x402 facilitator still needs to call it in production.
- **Web Bot Auth / AP2 verification is the Ed25519 primitive**, not full RFC 9421 structured
  signatures or W3C-VC encodings — flagged as follow-ups.
- **KYB provider is a deterministic stub** — a real provider (Middesk/Persona/LEI) drops into
  the interface.
- **Admin is a single testnet key** — production needs a Safe multisig + the upgrade timelock.
- **Landing page** was rejected; to be redone.
