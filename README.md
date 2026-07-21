# Agentic Commerce Trust Protocol (ACTP)

The trust and policy layer that sits **above** agentic payment rails (x402, Stripe/OpenAI ACP,
Google AP2, card networks). Before an AI agent spends money, ACTP answers: *who is this
merchant, how verified are they, what are they selling and on what terms, and how risky are
they?*

DNS + TLS/CT for merchant identity · OPA/Cedar for policy · IAM for agents. **The payment
protocol is not the innovation — the decision that happens before the payment is.**

This repository implements **V1–V14**: a canonical onchain Vendor Registry on Base with
graduated verification, hash-anchored + IPFS-content-addressed metadata, contract intelligence
and an explainable risk engine (the trust substrate) — plus the **cross-rail decision layer**
that is the defensible core: define a spending policy once and enforce it across x402, cards,
ACP, and AP2 with signed enforcement tokens, cross-rail budgets, org→dept→agent delegation,
human approval, and a tamper-evident receipt chain.

📄 **Design & strategy:** [`docs/design.md`](docs/design.md) ·
[`docs/strategy.md`](docs/strategy.md) · [`docs/policy.md`](docs/policy.md) ·
[`docs/landscape.md`](docs/landscape.md) ·
[`docs/trust-assumptions.md`](docs/trust-assumptions.md) · [`docs/api.md`](docs/api.md)

## What's implemented

| Component | Where |
|---|---|
| **V1** Vendor Registry — register/update/transfer/suspend/revoke/lookup, deterministic IDs, domain+wallet uniqueness, terminal revocation | `contracts/src/VendorRegistry.sol` |
| **V2** Verification — verifier RBAC, EIP-712 signed attestations (replay-safe), expiry/renewal/revocation, O(1) attester ban, levels 0–5 | `contracts/src/AttestationRegistry.sol` |
| **V3** Merchant metadata — versioned, JSON-Schema-validated, canonicalized + keccak256-anchored onchain, **content-addressed on IPFS** (CID = onchain URI) for availability + self-verifying retrieval, integrity verified on every read | `backend/src/services/metadata.ts`, `backend/src/storage/`, `packages/core` |
| **V4** Contract intelligence — term extraction (deterministic + optional Claude LLM) with confidence, provenance and source quotes; never presents AI output as verified fact | `backend/src/services/contractIntel/` |
| **V5** Risk engine — deterministic, versioned, explainable rules; score + reasons + evidence + inputs-snapshot hash; hard overrides for sanctions/revocation | `backend/src/services/risk/` |
| **V6/V11** Policy engine — deterministic, explainable, deny-by-default; readable policy language | `backend/src/policy/`, `packages/core/src/policy*.ts` |
| **V6** Cross-rail budgets — hold/settle, FX-normalized (one cap across card + stablecoin) | `backend/src/services/budgets.ts` |
| **V7/V9** Principals (org→dept→agent) + attenuated delegation | `backend/src/services/principals.ts` |
| **V8** Human approval — fail-closed, token minted on grant | `backend/src/services/approvals.ts` |
| **V10** Verification-weighted reputation · **V14** neutral discovery | `backend/src/services/reputation.ts`, `discovery.ts` |
| **V12** Rail-agnostic decision API + adapters (x402/ACP/card/AP2) + Ed25519 enforcement tokens | `backend/src/services/decisions.ts`, `rails/adapters.ts`, `crypto/tokens.ts` |
| **V13** Tamper-evident per-org receipt chain | `backend/src/services/receipts.ts` |
| **x402 enforcement** — settle-time guard a facilitator calls; refuses settlement without a valid, matching decision token | `backend/src/rails/x402.ts` |
| **MCP server** — ACTP as agent tools (resolve/risk/metadata/decide/discover) for any MCP agent | `mcp/` |
| **Vetted Bazaar** — turns unvetted x402 discovery into a trusted, ranked feed | `backend/src/services/bazaar.ts` |
| **Agent identity + mandates + KYB** — Web-Bot-Auth-style agent verification, AP2 mandate verification, pluggable KYB → level-3 attestation | `backend/src/crypto/agentAuth.ts`, `backend/src/services/kyb/` |
| Event indexer (reorg-aware, replayable), REST API, TypeScript SDK, deploy scripts, CI | `backend/`, `sdk/`, `contracts/script/`, `.github/` |

**Live on Base Sepolia (testnet):** VendorRegistry `0xaa77A898e44C23d31eE6B54561F9ec8A375328B6`, AttestationRegistry `0x1a06C6bE8894d6A5771B61ba62c3355e2A261256` — see `contracts/deployments/base-sepolia.json`. A Solana/Anchor port of the registry is in `solana/` (written, unbuilt). Full inventory: [`docs/OVERVIEW.md`](docs/OVERVIEW.md).

## Architecture

```
contracts/        Foundry — VendorRegistry + AttestationRegistry (UUPS, on Base)
packages/core/    Shared: canonical JSON hashing, ABIs, schemas, types
backend/          Fastify API + indexer + metadata/contract/risk services (Postgres/PGlite)
sdk/              TypeScript SDK: onchain writes (viem) + API reads + integrity verification
docs/             Design doc, landscape research, trust assumptions, API reference
```

Canonical vendor **identity** lives onchain (neutral, composable, equivocation-resistant).
Everything heavy/mutable/interpretive lives offchain, cryptographically linked to the chain
by hash — metadata documents are stored **content-addressed on IPFS** so they're retrievable
from any gateway and self-verifying, with the CID recorded as the onchain URI. The backend is
a view+enrichment layer, trusted for freshness but **never for integrity** — every document is
re-hashed and checked against both its content address and the onchain anchor. See
`docs/design.md` §3.

## Quick start

Prerequisites: Node 22+, [Foundry](https://getfoundry.sh).

```bash
npm install
npm run build                 # core + sdk + backend

# contracts
cd contracts && forge test    # 76 tests: unit, access-control, signature, fuzz, invariant, upgrade
cd ..

# TypeScript unit + integration tests (embedded PGlite, no external services)
npm test

# full end-to-end: spins up anvil, runs the deploy script, indexes, drives the SDK
# through register -> verify -> metadata -> contract intelligence -> risk -> suspension
npm run e2e -w backend
```

### Local development

```bash
# 1. start a chain
anvil

# 2. deploy both registries (prints proxy addresses)
cd contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. run the backend (embedded PGlite if DATABASE_URL is unset)
cd ..
VENDOR_REGISTRY_ADDRESS=0x… ATTESTATION_REGISTRY_ADDRESS=0x… \
  CHAIN_ID=31337 npm run dev -w backend
```

`docker-compose up` brings up Postgres + anvil + backend together. Copy `.env.example` to
`.env` for the full configuration surface.

### Using the SDK

```ts
import {ActpClient} from "@actp/sdk";

const actp = new ActpClient({
  apiUrl: "http://localhost:8402",
  rpcUrl: "http://localhost:8545",
  vendorRegistryAddress: "0x…",
  attestationRegistryAddress: "0x…",
});

// One decision call, any rail. Hand it a rail-native payload; get allow/deny/approve
// + a signed enforcement token. The SAME policy applies whether this is x402 or a card.
const {decision} = await actp.decideForRail("x402", "req-123", "agent_abc", {
  network: "eip155:8453",
  payTo: payToAddress,
  asset: {symbol: "USDC", decimals: 6},
  amountAtomic: "3000000", // 3 USDC
  category: "software",
});

if (decision.outcome === "deny") return `DENY: ${decision.reasons.find((r) => r.effect === "deny")?.rule}`;
if (decision.outcome === "require_approval") return `HOLD: approval ${decision.approvalId}`;

// ALLOW: hand decision.token to the x402 facilitator; it verifies the signature before settling.
await settleX402(payToAddress, decision.token);
await actp.settle(decision.decisionId, "fulfilled"); // settles the budget hold + receipt
```

## Security & testing

Production patterns throughout: UUPS upgradeability behind role-gated auth, ERC-7201
namespaced storage, EIP-712 with chain/contract/nonce binding, strict status state machine,
contract-enforced uniqueness, fail-closed defaults. Tested with unit, access-control,
signature-verification, edge-case, **fuzz** (soundness/completeness of domain validation,
uniqueness, expiry windows, nonce enforcement), **invariant** (domain bijection, terminal
revocation, metadata monotonicity, inactive⇒level-0), **upgrade**, and a full **end-to-end**
suite. Static analysis via Slither + solhint in CI. Trust assumptions and governance:
[`docs/trust-assumptions.md`](docs/trust-assumptions.md).

## Roadmap (post-V14)

Merkle-root anchoring of receipts onchain · rail enforcement-point middleware (x402 facilitator
plugin, card-issuer JIT hook) · KYB-provider verifier integrations · decentralized verifier
network + transparency logs · pinning-service IPFS backend. See `docs/design.md` §7 and
`docs/strategy.md`.

## License

Apache-2.0
