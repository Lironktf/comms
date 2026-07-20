# Agentic Commerce Trust Protocol (ACTP)

The trust and policy layer that sits **above** agentic payment rails (x402, Stripe/OpenAI ACP,
Google AP2, card networks). Before an AI agent spends money, ACTP answers: *who is this
merchant, how verified are they, what are they selling and on what terms, and how risky are
they?*

DNS + TLS/CT for merchant identity · OPA/Cedar for policy · IAM for agents. **The payment
protocol is not the innovation — the decision that happens before the payment is.**

This repository is a production-grade MVP of **V1–V5**: a canonical onchain Vendor Registry
on Base, graduated verification with signed attestations, versioned hash-anchored merchant
metadata, contract-terms intelligence with provenance, and an explainable risk engine.

📄 **Design & research:** [`docs/design.md`](docs/design.md) ·
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
| Event indexer (reorg-aware, replayable), REST API, TypeScript SDK, deploy scripts, CI | `backend/`, `sdk/`, `contracts/script/`, `.github/` |

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

// x402 pre-payment check: resolve the payee wallet, then decide.
const vendor = await actp.resolveWallet(payToAddress);
if (!vendor) return "DENY: unknown counterparty"; // fail closed

const risk = await actp.getRisk(vendor.vendorId);
if (risk.riskLevel === "critical") return `DENY: ${risk.reasons[0]?.rule}`;

const meta = await actp.getVerifiedMetadata(vendor.vendorId);
if (!meta.trusted) return "REQUIRE_APPROVAL: metadata not anchored/verified";
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

## Roadmap (post-MVP)

V6 policy engine (Cedar) · V7 per-agent permissions · V8 human approval · V9 attenuated
delegation · V10 reputation · V11 policy language · V12 decision API + enforcement tokens ·
V13 receipts/audit · V14 discovery. See `docs/design.md` §4.

## License

Apache-2.0
