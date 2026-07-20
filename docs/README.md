# ACTP Documentation

**Agentic Commerce Trust Protocol** — the trust and policy layer above agentic payment rails (x402, ACP, AP2, card networks).

| Document | Contents |
|---|---|
| [design.md](./design.md) | Vision, principles, architecture, V1–V14 component designs with alternatives and tradeoffs, onchain/offchain split, threat model, x402 integration, governance |
| [strategy.md](./strategy.md) | Positioning: the cross-rail policy/enforcement thesis, moats, market read, and what would kill it |
| [policy.md](./policy.md) | Policy language, decision model, enforcement tokens, delegation, budgets, receipts (V6/V11/V12) |
| [landscape.md](./landscape.md) | Competitive & standards research (protocols, identity standards, policy engines, competitors, gap analysis) as of July 2026 |
| [trust-assumptions.md](./trust-assumptions.md) | Explicit trust assumptions, admin powers, and governance roadmap for the deployed MVP |
| [api.md](./api.md) | REST API reference |

## Scope (V1–V14, implemented)

**Trust substrate (V1–V5):**
- **V1** Vendor Identity Registry — Solidity, canonical on Base
- **V2** Verification — verifier RBAC + EIP-712 signed attestations with expiry/renewal/revocation
- **V3** Merchant Metadata — versioned, JSON-Schema-validated, hash-anchored onchain + IPFS content-addressed
- **V4** Contract Intelligence — term extraction with confidence + provenance
- **V5** Risk Engine — deterministic, explainable, versioned rulesets

**Cross-rail decision layer (V6–V14) — the defensible core, see [strategy.md](./strategy.md):**
- **V6** Policy engine (decidable, explainable) + cross-rail hold/settle budgets
- **V7/V9** org→dept→agent principals + attenuated delegation
- **V8** human approval (fail-closed, token-on-grant)
- **V10** verification-weighted reputation · **V11** readable policy language
- **V12** rail-agnostic decision API + adapters (x402/ACP/card/AP2) + signed enforcement tokens
- **V13** tamper-evident receipt chain · **V14** neutral merchant discovery

## Repository layout

```
contracts/   Foundry project: VendorRegistry.sol, tests (unit/fuzz/invariant), deploy scripts
backend/     Fastify + Postgres: indexer, metadata service, contract intelligence, risk engine, REST API
sdk/         TypeScript SDK (viem onchain access + API client + integrity verification)
docs/        This documentation
```
