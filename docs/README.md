# ACTP Documentation

**Agentic Commerce Trust Protocol** — the trust and policy layer above agentic payment rails (x402, ACP, AP2, card networks).

| Document | Contents |
|---|---|
| [design.md](./design.md) | Vision, principles, architecture, V1–V14 component designs with alternatives and tradeoffs, onchain/offchain split, threat model, x402 integration, governance |
| [landscape.md](./landscape.md) | Competitive & standards research (protocols, identity standards, policy engines, competitors, gap analysis) as of July 2026 |
| [architecture.md](./architecture.md) | MVP implementation architecture: contracts, backend, indexer, SDK (written alongside the implementation) |
| [trust-assumptions.md](./trust-assumptions.md) | Explicit trust assumptions, admin powers, and governance roadmap for the deployed MVP |
| [api.md](./api.md) | REST API reference |

## MVP scope (V1–V5)

- **V1** Vendor Identity Registry — Solidity, canonical on Base
- **V2** Verification — verifier RBAC + EIP-712 signed attestations with expiry/renewal/revocation
- **V3** Merchant Metadata — versioned, JSON-Schema-validated, hash-anchored onchain
- **V4** Contract Intelligence — term extraction with confidence + provenance
- **V5** Risk Engine — deterministic, explainable, versioned rulesets

## Repository layout

```
contracts/   Foundry project: VendorRegistry.sol, tests (unit/fuzz/invariant), deploy scripts
backend/     Fastify + Postgres: indexer, metadata service, contract intelligence, risk engine, REST API
sdk/         TypeScript SDK (viem onchain access + API client + integrity verification)
docs/        This documentation
```
