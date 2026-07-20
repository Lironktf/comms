# ACTP Strategy & Positioning

**Status:** v0.1 · **Date:** 2026-07-20 · Grounded in the mid-2026 market research summarized below.

This document states, bluntly, what ACTP is betting on, why the bet is defensible, and what would kill it. It exists because the technically interesting part of this project (V1–V5, the merchant registry) is the *commoditizable* part, and the durable part (V6+, cross-rail policy + enforcement) is the part that has to be built and sold deliberately.

## The one-line thesis

**The neutral, cross-rail control plane that decides — and enforces — whether an AI agent's purchase is allowed, before money moves on any rail.** Not a merchant directory (that commoditizes); a policy + decision + liability layer that spans x402, cards, ACP, and AP2 because no single rail or model provider can.

## What the market says (mid-2026)

- **The problem is real and named.** "Know Your Agent" is an established, funded category; regulators (EU AI Act transparency Aug 2026, Singapore IMDA agent-identity requirements) are converging on verifiable agent identity + authorization; enterprises are already asking for agent spending controls (Ramp Agent Cards; Uber capping agent tool spend after burning its budget).
- **Demand is anticipatory, not yet at scale.** Autonomous purchase volume is small and, on crypto rails, provably inflated (~80% of x402 volume was wash/self-dealing in the July 2026 Visa–Artemis study; card-rail agentic checkout is ~1.5% of e-commerce; humans still gate almost every checkout). Real pull is a 12–24 month story.
- **The merchant-side trust lane is nearly empty.** The funded field (Skyfire, Catena, Nekuda, Vouched, Prove, Sumsub, Experian) builds the *inverse* — verifying the *agent* so a merchant can trust it. Almost nobody is building the open, agent-facing layer that verifies the *merchant*. The only serious force there is **Visa's Agentic Directory** — closed, card-network-scoped, and unshipped as of mid-2026 (Visa's own merchant-adoption horizon is 2027+).
- **The standards deliberately left the trust/policy slot open.** x402, ACP, UCP, AP2 all consolidated the *rails* but none mandates a merchant-verification or cross-rail policy layer. The seat is reserved; it is a 12–18 month execution race to sit in it.

## Why the current build had to grow past V1–V5

History is unambiguous about layers like this: the raw "is this legit" signal trends to **free** once the platform that owns checkout builds it in (Stripe Radar bundled; Riskified down ~80% from IPO; EV certificates abandoned). The survivors moved up into **decisioning and liability** (Okta, Alloy, Persona at $2B as "the verified layer for an agentic world").

Translated to ACTP: V1–V5 (registry, verification, risk score) are necessary substrate but absorbable on their own. The defensible product is **V6–V14 — the cross-rail policy engine, the signed decision/enforcement token, budgets, delegation, approvals, and the audit trail** — which is what this codebase now implements.

## The three bets, and the moats

1. **Cross-rail neutrality is the moat Visa/Mastercard/Stripe structurally cannot copy.** Each incumbent's trust check is scoped to its own network. ACTP normalizes x402, cards, ACP, and AP2 into one `PurchaseRequest`, evaluates one policy, and enforces with one signed token any rail's enforcement point can verify. "Define policy once; enforce across card + stablecoin + A2A" is a sentence only a neutral layer can say. The budget model proves it: a `$10k/month` cap draws down across a USD card charge and a USDC x402 payment simultaneously.

2. **Enforcement + liability, not a score.** The product is not a number an incumbent can bundle away; it is the **decision token** an enforcement point requires before settling, plus the tamper-evident receipt chain that binds intent → authorization → settlement across rails. The roadmap terminus is bearing/managing liability — the Alloy/Forter shape that survives.

3. **Sell the control plane to enterprises now, not consumers.** The pull that exists *today* is corporate: a company whose agents pay across USDC, cards, and SaaS has no cross-rail spending-governance plane. That is a budget line in 2026, unlike consumer autonomous checkout which is a 2028 story. Go-to-market wedge: org → department → agent policy + budgets + human approval, integrated where agents already spend.

## What kills this (and the mitigations)

| Risk | Mitigation in the design |
|---|---|
| **Visa's Agentic Directory ships and is "good enough"** | Stay obsessively cross-rail + neutral; Visa only covers Visa. Serve the long tail and the multi-rail enterprise Visa won't. |
| **Absorption**: the registry/score becomes a free platform feature | Lead with policy + enforcement token + receipts (the un-bundleable part); treat V1–V5 as substrate, not product. |
| **Too early**: runway dies before autonomous purchasing is real | Sell enterprise governance now (real budget); don't price against (fake) transaction volume. |
| **Standard converges with a native trust layer** | Integrate as the policy extension of every rail (x402 `extensions`, ACP risk signals, AP2 mandate verification) rather than competing with the rail. |

## Non-negotiables (encoded in the code)

- **Cross-rail or it's nothing.** Every rail flows through one adapter → one decision → one token. Adding a rail is adding an adapter; nothing downstream changes.
- **Neutral.** Discovery ranking takes no pay-for-placement input. Reputation is verification-weighted (sybil-damped), never asserted.
- **Fail closed.** Unknown counterparty, no policy, expired token, or unavailable FX all default to deny/approval, never silent allow.
- **Explainable + reproducible.** Every decision returns the exact rules and evidence, plus a context hash that reproduces it.

See `design.md` for the architecture and `landscape.md` for the underlying competitive research.
