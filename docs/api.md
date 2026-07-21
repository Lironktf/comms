# ACTP REST API

Base path `/v1`. Reads are public. Mutating endpoints require `x-api-key: <ADMIN_API_KEY>`
when the backend is configured with one (open in dev mode).

All `vendorId` path params are `0x`-prefixed 32-byte hex (`keccak256(scheme, domainHash)`).
Errors are `{ "error": "<message>" }` with a matching HTTP status (422 validation, 404 not
found, 401 auth, 409 conflict, 413 too large).

## Health

```
GET /health -> { "status": "ok" }
```

## Vendors (V1/V2)

```
GET /v1/vendors                      # list (?limit, ?offset)
GET /v1/vendors?domain=acme.example  # resolve by domain  -> { vendor }
GET /v1/vendors?wallet=0x…           # resolve by wallet   -> { vendor }  (primary x402 check)
GET /v1/vendors/:vendorId            -> { vendor }
GET /v1/vendors/:vendorId/attestations -> { attestations: [...] }
```

`vendor` includes `owner`, `status` (`active|suspended|revoked`), `domains[]`, `wallets[]`,
`x402Endpoint`, `metadataHash`, `metadataVersion`, `contractMetadataHash`,
`verificationLevel` (0–5, computed from live attestations), and timestamps. Unknown
domain/wallet/vendor → **404** (fail closed).

## Metadata (V3)

```
PUT /v1/vendors/:vendorId/metadata     # body: merchant metadata document (admin)
   -> 201 { version, canonicalHash, cid, uri, next_step }
GET /v1/vendors/:vendorId/metadata
   -> { vendorId, version, document, canonicalHash, cid, ipfsAvailable, createdAt, integrity }
GET /ipfs/:cid                          # content-addressed gateway -> raw document bytes
```

`integrity` ∈ `verified` (document hash equals onchain anchor) · `not_anchored` (stored but
not yet anchored, or anchor points at a different stored version) · `hash_mismatch` (stored
document does not match its recorded hash — untrusted) · `no_document`.

The document is stored content-addressed (IPFS raw block); `cid` is its CIDv1 and `uri` is
`ipfs://<cid>`. After `PUT`, the vendor owner anchors `canonicalHash` **and** sets the URI to
`uri` onchain via `VendorRegistry.setMetadata`. `ipfsAvailable` reports whether the document
is currently retrievable from the content-addressed store. `GET /ipfs/:cid` is a caching
gateway that re-verifies bytes against the CID before serving; clients re-verify regardless.

**Trustless retrieval** (no operator trust): read the CID from the onchain `metadataURI`,
fetch `<gateway>/ipfs/<cid>` from any IPFS gateway, and verify against both the content
address and the onchain keccak anchor. The SDK's `getMetadataTrustless` does exactly this.

## Contract intelligence (V4)

```
POST /v1/vendors/:vendorId/contract-documents   # { content, docType?, sourceUrl? } (admin)
   -> 201 { vendorId, documentHash, terms, extractor, extractorVersion, createdAt, merchantAnchored }
GET  /v1/vendors/:vendorId/contract-terms
   -> { terms, merchantAnchored, ... }
```

Each term in `terms` carries `{ value, confidence (0–1), source, references[], requiresReview? }`.
`source` ∈ `merchant_declared | verifier_attested | ai_extracted | deterministic_parse`.
`merchantAnchored` is `true` only when the vendor owner anchored that exact document hash
onchain — otherwise the terms are **information, not verified fact**.

## Risk (V5)

```
GET  /v1/vendors/:vendorId/risk           # evaluate now + persist
   -> { vendorId, riskLevel, score, reasons[], rulesetVersion, evaluatedAt, inputsSnapshotHash }
GET  /v1/vendors/:vendorId/risk/history   # ?limit -> { history: [...] }
POST /v1/vendors/:vendorId/risk-signals   # { signal, value, source } (admin)
   -> 204
```

`riskLevel` ∈ `low | medium | high | critical`. Each entry in `reasons` is
`{ rule, weight, evidence }`. Scores are comparable only within a `rulesetVersion`.
`inputsSnapshotHash` lets any consumer recompute the score from the same signals.

Accepted `signal` names (external observations): `domain_age_days`, `wallet_age_days`,
`wallet_flagged`, `sanctions_match`, `phishing_reports`, `security_incidents`,
`refund_complaints`.

## Principals & delegation (V7/V9)

```
POST   /v1/orgs                          { displayName }                     (admin) -> principal
POST   /v1/principals/:id/children       { kind: department|agent, displayName } (admin)
GET    /v1/principals/:id                -> { principal, chain }
POST   /v1/principals/:id/status         { status: active|suspended }        (admin)
PUT    /v1/principals/:id/policy         { text | document, version? }       (admin)  # V11
GET    /v1/principals/:id/policy         -> { document, text }
POST   /v1/delegations                   { from, to, constraints }           (admin)  # narrow-only
DELETE /v1/delegations/:id                                                   (admin)
```

`constraints`: `{ maxAmount?, rails?[], categories?[], allowedVendors?[], deniedVendors?[], expiresAt? }`
(amounts in the org's normalized currency). Policy `text` uses the language in `policy.md`.

## Budgets (V6, cross-rail)

```
POST /v1/principals/:id/budgets   { period: day|month|total, currency, limit }  (admin)
GET  /v1/principals/:id/budgets
```

## Decisions (V12)

```
POST /v1/decisions                # body: rail-agnostic PurchaseRequest  -> Decision
POST /v1/decisions/rail/:rail     # body: { requestId, principal, payload } (rail = x402|acp|card|ap2)
                                  #   -> { normalized, decision }
GET  /v1/decisions/:id
GET  /v1/orgs/:orgId/decisions
POST /v1/decisions/:id/settle     { outcome: fulfilled|disputed|refunded|failed }  (admin)
POST /v1/decisions/verify-token   { token }  -> { valid, payload? }
GET  /v1/decisions/signing-key    -> { publicKeyPem }
```

`Decision`: `{ decisionId, outcome (allow|deny|require_approval), reasons[], vendorId,
verificationLevel, riskLevel, riskScore, policyVersion, contextHash, holdIds[], approvalId, token }`.
The `token` (present only on allow) is a short-lived Ed25519 JWS an enforcement point verifies
before settling. Same `Decision` shape and token format for every rail.

## Approvals (V8)

```
GET  /v1/orgs/:orgId/approvals               -> pending approvals
POST /v1/approvals/:id/approve   { resolver } (admin) -> Decision (now allow, with token)
POST /v1/approvals/:id/deny      { resolver, reason } (admin)
```

## Receipts (V13), reputation (V10), discovery (V14)

```
GET /v1/orgs/:orgId/receipts
GET /v1/orgs/:orgId/receipts/verify          -> { valid, length, brokenAtSeq }
GET /v1/vendors/:vendorId/reputation         -> verification-weighted score (null below min sample)
GET /v1/discovery?category=&minLevel=&maxRisk=&limit=   -> ranked, no pay-for-placement
```

## x402 enforcement (F1)

```
POST /v1/x402/authorize-settlement   { token, payment:{payTo, amountAtomic, asset} }
     -> { authorized, reason, payload? }     # the facilitator's settle-time guard
GET  /v1/x402/extension/:vendorId    -> { extensions }   # advertise vendorId in PaymentRequired
```
A facilitator calls `authorize-settlement` before settling; a payment with no valid,
matching decision token is refused. Verification is by signature against the public key from
`GET /v1/decisions/signing-key` — no shared secret.

## Vetted Bazaar (F3)

```
POST /v1/bazaar/ingest    { listings:[{resourceUrl, payTo?, domain?, serviceName?, tags?, price?}], source? } (admin)
GET  /v1/bazaar/vetted?minLevel=&maxRisk=&tag=&eligibleOnly=true&limit=
     -> { listings:[ { ..., vendorId, verificationLevel, riskLevel, eligibleForAgentPurchase, reasons, rank } ] }
```
Each listing's payout wallet/domain is resolved against the registry and scored;
`eligibleForAgentPurchase` + `reasons` say whether an agent should transact. No pay-for-placement.

## KYB + agent/mandate verification (F4)

```
POST /v1/vendors/:vendorId/kyb   { legalName?, registrationId?, jurisdiction? } (admin)
     -> { passed, provider, evidenceHash, attestationInput }   # attestationInput -> onchain level-3
GET  /v1/vendors/:vendorId/kyb   -> latest KYB result
POST /v1/agents/verify           { agentAuth?, mandate? } -> { agent, mandate }  # Ed25519 verification
```
A decision request may carry `agentAuth` (Web-Bot-Auth-style agent signature) and `mandate`
(AP2-style signed user mandate); when valid they set the `agent.verified` / `mandate.present`
policy attributes, so a policy can require them.

## Agent tools (MCP)

Run the MCP server (`mcp/`, `actp-mcp` bin) pointed at the backend (`ACTP_API_URL`). Exposes
`actp_resolve_merchant`, `actp_get_risk`, `actp_verified_metadata`, `actp_decide`,
`actp_discover` to any MCP-speaking agent.
