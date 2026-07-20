# Landscape & Research: Agentic Commerce Trust Infrastructure

**As of:** July 2026. Sources were gathered via primary specs and press where possible; items marked ⚠ are single-source or unverified.

---

## 1. Payment Protocols (the rails we sit above)

### x402 (x402 Foundation / Linux Foundation, ex-Coinbase)
- v2 spec released 2025-12-11; governance transferred to the **x402 Foundation** (Linux Foundation), operational 2026-07-14, ~40 members incl. Adyen, AWS, Amex, Circle, Cloudflare, Coinbase, Fiserv, Google, Mastercard, Monad, MoonPay, Ripple, Shopify, Solana Foundation, Stellar, Stripe, Visa.
- Mechanics: HTTP 402 → `PaymentRequired{x402Version, resource, accepts[PaymentRequirements], extensions}`; `PaymentRequirements{scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds}`. `exact` scheme on EVM = EIP-712-signed EIP-3009 `transferWithAuthorization`, facilitator settles (gasless payer). Facilitator API: `POST /verify`, `POST /settle`, `GET /supported`. ⚠ v2 header renames (`PAYMENT-*` vs v1 `X-PAYMENT*`) confirmed only via secondary write-ups.
- Discovery: **Bazaar** (`GET /discovery/resources`), 10k+ paid tools indexed — **explicitly no vetting, reputation, or provider verification**.
- Trust posture: payee is a bare wallet address; budget management explicitly out of scope; no KYC/KYB, delegation, disputes, or refunds.
- Adoption reality check: headline figures (~165M tx, ~$50M cumulative by Apr 2026) vs. a July 2026 population-scale study verifying only ~$188k to identifiable independent services (~$20M "possibly genuine"); an Artemis wash-filter cut volume to ~$1.6M. **The rails are real and heavily backed; organic demand is currently small and polluted with synthetic volume.**

### Google AP2 (Agent Payments Protocol)
- Announced 2025-09-16, 60+ partners; spec v0.2 at ap2-protocol.org; extension of A2A (Linux Foundation).
- v0.2 model: two **Verifiable Digital Credentials** — Checkout Mandate (open: constraints; closed: authorized final cart) and Payment Mandate (open: budget + instruments; closed: amount bound to checkout). ⚠ Exact W3C-VC encoding not committed in spec text; older coverage still describes three mandates (Intent/Cart/Payment).
- Best-in-class signed audit trail; **A2A x402 extension** lets AP2 mandates settle over x402. FIDO Alliance standardizing "verifiable intent."
- Gaps: no policy engine (mandates record what a user authorized; nothing evaluates whether it *should* be authorized), no merchant legitimacy verification, thin production use.

### Stripe/OpenAI ACP (Agentic Commerce Protocol)
- Announced 2025-09-29 with ChatGPT Instant Checkout; Apache-2.0 spec (agenticcommerce.dev), stable version dated 2026-04-17; OpenAI + Stripe founding maintainers, Meta involved.
- **Shared Payment Token (SPT)**: scoped to one merchant and cart total; delegated via `POST /agentic_commerce/delegate_payment` with allowance, risk signals. Merchant remains merchant-of-record.
- Adoption: Etsy; Shopify onboarding from Jan 2026 (Glossier, SKIMS, Vuori…); PayPal building an ACP server; Walmart ChatGPT app. ⚠ ~4% OpenAI fee and a reported Mar 2026 scale-back of in-chat checkout are secondary-source claims.
- Trust posture: agent identity = "it's ChatGPT" (bilateral platform trust); merchant identity = PSP onboarding; per-cart cap only — no cumulative/category/velocity budgets; no portable intent artifact.

### Visa Intelligent Commerce / Trusted Agent Protocol (TAP)
- TAP (Oct 2025, built with Cloudflare): RFC 9421 HTTP Message Signatures, Ed25519/PS256, 8-minute validity windows, nonce replay cache; three linked artifacts (Agent Recognition Signature, Agentic Consumer Recognition Object, Agentic Payment Container — incl. a "Browsing IOU" answering HTTP 402). Keys via well-known JWKS.
- June 2026 (Visa Payments Forum): **Agentic Directory/Registry of Visa-verified agents and merchants** + Agent Score + OpenAI partnership. **This is the closest incumbent competitor to ACTP — but closed, card-network-centric, acquirer-mediated.**

### Mastercard Agent Pay
- Announced 2025-04-29. **Agentic Tokens** (MDES extension) bind {card credential, agent identity, merchant scope, consent policy}; Decision Intelligence adds agent-specific signals. Verifiable Intent pilots Feb 2026; all US cardholders targeted by Nov 2026. **Agent Pay for Machines** (June 2026): 30+ companies; agent permissions recorded on Polygon, Solana, Base.

### Others
- **UCP (Google + Shopify, Jan 2026):** full commerce lifecycle for AI surfaces; AP2-compatible; UCP-vs-ACP is the retail checkout standards fight.
- **PayPal Agentic Commerce Services** (Oct 2025): multi-protocol (ACP + AP2).
- **Cloudflare:** Pay-Per-Crawl → x402 Monetization Gateway (waitlist 2026-07-01); Web Bot Auth / signature-agent cards (JWKS + operator metadata at well-known URLs — a registry pattern that works for merchants too). ⚠ stablecoin naming (NET Dollar / "Open USD") inconsistent across sources.
- **L402** (Lightning, macaroon-based) niche; **MPP** multi-rail streaming micropayments; **AIP** (arXiv 2026) — delegation identity still unstandardized.

### Cross-protocol gap matrix
No protocol provides: (1) merchant identity/trust for long-tail sellers (x402 Bazaar unvetted; others inherit PSP onboarding); (2) cross-rail org-level spending policy (x402: out of scope; ACP: per-cart cap; card tokens: rail-bound); (3) portable multi-hop delegation with revocation (TAP, Agentic Tokens, AP2 mandates, SIWE are four incompatible answers); (4) unified receipt/audit schema binding intent → authorization → settlement; (5) agent-tuned fraud detection outside proprietary rails; (6) refunds/disputes on stablecoin rails; (7) synthetic-volume detection.

---

## 2. Identity, Attestation & Trust Standards

- **W3C VC 2.0** — Recommendation 2025-05-15 (with Data Integrity, ECDSA/EdDSA suites, Bitstring Status List). **DID 1.1** at Candidate Rec (⚠ final REC status to confirm). Practical read: mature data model; ecosystem fragmented (190+ DID methods, proof-format schism — EUDI chose SD-JWT/mdoc). Use as envelope; don't bet on the SSI ecosystem.
- **DID methods:** `did:web` pragmatic for merchants (anchored to domain, but inherits WebPKI wholesale, silent key-swap risk); `did:pkh`/`did:key` for wallet-derived identity; `did:ethr` for onchain rotation.
- **GLEIF LEI / vLEI:** LEI passed 3M active entities Q1 2026 (~$50–100/yr, open bulk data) — best global legal-entity baseline. vLEI (KERI/ACDC, QVI issuers, EGF v4.0 2026-03-25) = high-assurance tier; tooling niche, issuer network tiny (⚠ no public issuance count). Posture: LEI baseline, vLEI premium tier.
- **ENS gasless DNSSEC** (EP5.1): any DNSSEC domain becomes an ENS name via one `_ens` TXT record; CCIP-Read + onchain DNSSECOracle → cryptographic domain↔wallet binding without gas. Caveats: patchy DNSSEC adoption; gateway dependency. ⚠ ENSv2/Namechain launch status unconfirmed.
- **EAS (Ethereum Attestation Service):** 9.5M+ attestations, 450k+ attesters (May 2026); onchain + offchain (EIP-712) modes, revocation/expiry built in; used by Coinbase Base Verifications, Optimism, Gitcoin Passport. Best attestation substrate on Base; it is a dumb pipe — semantics/governance are ours. **Verax** (Consensys/Linea), **Sign Protocol** (token-driven) are peers.
- **ERC-8004 "Trustless Agents"** (draft; identity/reputation/validation registries; mainnet reference contracts ~2026-01-29): the *agent-side* mirror of ACTP's merchant registry. Documented flaws: sybil-farmed reputation, **transferable identity NFTs enabling purchase of aged clean identities**, spam. Interop target + cautionary tale.
- **WebPKI/CT lessons:** any-CA-can-issue-for-any-domain = weakest-issuer security; **Certificate Transparency fixed it via public append-only audit, not prevention**. **EV certificates failed** (humans ignore indicators; verified legal names mislead — "Stripe, Inc. of Kentucky"; Chrome/Safari dropped EV UI 2019). Both lessons are load-bearing in ACTP's design (machine-consumed signals; evented auditable registry).
- **Trust registries:** ToIP **TRQP v2.0** in public review (query interface worth conforming to); **eIDAS 2.0** (EUDI wallets mandatory Q4 2026, relying-party registries = regulator-run registry precedent); **OpenID Federation 1.0/1.1** (Feb/May 2026) — signed entity statements at well-known URLs with trust-anchor chains: the best-engineered federation pattern; ACTP's merchant self-publication model follows it.
- **KYB suppliers (not competitors):** Middesk (US SOS/TIN/watchlists/UBO), Persona, Trulioo (~195 countries), Alloy, Sumsub. ⚠ Pricing uniformly non-public (est. low-single-digit to tens of $ per check).
- **Card-network prior art:** merchant identity = acquirer-assigned MIDs (not portable), 4-digit MCC codes (coarse, miscategorized), Mastercard **MATCH** negative list (acquirer-only, 5-year entries). The incumbent system is closed, acquirer-mediated, negative-signal-only — the open positive merchant identity layer does not exist.

---

## 3. Policy, Delegation & Enforcement (V6+ groundwork)

- **Cedar** (AWS, open source): decidable, formally verified (Lean), **SMT-based policy analysis** (prove "no policy grants X"), µs eval, WASM/embeddable, native entity hierarchy. Limitation shared by all engines: no aggregates — budgets computed outside, injected as context. **Best fit for spending policy.**
- **OPA/Rego:** most expressive, WASM-compilable, no formal-analysis story. **OpenFGA/Zanzibar:** relationship graphs — good for org hierarchy, poor for numeric spend predicates. **Casbin/Kyverno:** not fits.
- **Delegation carriers:** **Biscuit** (Ed25519 blocks + embedded Datalog checks; offline attenuation — arguably best for portable spending caveats), **UCAN** (DID-native cert chains; token bloat), ZCAP-LD (dormant), Macaroons (too flat), **OAuth RAR** (RFC 9396 — payments-shaped `authorization_details`; the interop surface toward fintech APIs), GNAP (RFC 9635, thin adoption). IETF draft on attenuating agent tokens + arXiv AIP show the space is unstandardized.
- **Onchain spend controls:** ERC-4337 + ERC-6900/7579 modules; **ERC-7715** `wallet_grantPermissions` (draft; MetaMask Delegation Toolkit ships allowance/periodic/streaming limits); **Coinbase Spend Permissions** (`SpendPermissionManager` on Base: per-token recurring allowances, revocable); **Safe** Allowance Module + Guards (m-of-n approvals native); Coinbase **Agentic Wallets** (Feb 2026: MPC + x402 client + policy checks pre-signing); Privy/Turnkey policy-gated signing. Pattern: strong on amount/time/token, **weak on semantics** (category, vendor age, "no subscriptions") — exactly the gap a policy oracle + registry fills.

---

## 4. Competitors

| Player | What they do | Relation to ACTP |
|---|---|---|
| **Visa Agentic Directory + TAP** | verified agents & merchants inside Visa's network | closest incumbent; closed, card-rail-only |
| **Catena Labs** ($18M seed + ⚠$30M A; Circle co-founder) | AI-native regulated FI; Agent Commerce Kit (identity, receipts, approvals) | most direct vision-level competitor; bank-anchored, not neutral infra |
| **Skyfire** (~$9.5M) | KYAPay: agent identity JWT + payment authority + caps | agent-side identity; thin policy, no merchant verification |
| **Nekuda** ($5M; Amex/Visa Ventures) | agentic mandates (per-purchase intent + limits) | per-purchase artifact, not org policy hierarchy |
| **Vouched** ($17M A) / Sumsub KYA / Prove | Know-Your-Agent verification, agent passports | verify agents *to* merchants — mirror image of ACTP (merchants *to* agents) |
| **Ramp Agent Cards / Lithic ASA / Marqeta** | JIT-auth virtual cards for agents | card-rail enforcement points; potential partners/consumers of ACTP decisions |
| **Payman, PayOS, Prava, Proxy, Crossmint, Privy, Turnkey** | agent wallets / payouts with basic limits | wallet-layer caps; no semantic policy, no merchant trust |
| **Galileo Agent Control, Prisma AIRS, MCP gateways** | tool-call guardrails | govern tool calls generally; no purchases/merchant verification |
| **Experian "Agent Trust"** (2026) | credit-bureau agent scoring | signal supplier or rival scorer |

**Nobody combines**: open merchant identity registry + graduated verification + contract intelligence + explainable risk + (later) cross-rail policy enforcement. Agent-side identity is getting crowded; **the merchant-side trust layer is comparatively unclaimed outside Visa's closed directory** — that is ACTP's unique position.

---

## 5. Gaps ACTP Uniquely Fills

1. Open, rail-agnostic **merchant identity + verification** (vs. Bazaar's nothing, PSP-siloed onboarding, Visa's walled directory).
2. **Machine-readable contract terms** with honest provenance (nobody does this).
3. **Explainable, reproducible merchant risk** consumable by any agent framework.
4. Later: **portable, formally analyzable spending policy** enforced across card + stablecoin + A2A rails, with policy-triggered human approval — identified as unoffered by every player surveyed.
