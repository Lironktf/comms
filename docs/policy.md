# ACTP Policy Language & Decision Model (V6/V11/V12)

The cross-rail spending policy: define rules once, and they are enforced identically whether
the agent pays over x402, a card, ACP, or AP2.

## Writing a policy

Policies are written in a compact, readable line form (V11) that compiles to a validated JSON
document. One line = one statement; conditions after `when` are AND-joined; `#` is a comment;
an optional `[id]` names the statement.

```
# Corporate spending policy
[no-crit]   deny when risk.level == "critical"
[active]    deny when vendor.status != "active"
[young]     deny when vendor.domainAgeDays < 90
[big]       require_approval when amount > 250
[subs]      require_approval when subscription == true
[verified]  allow when vendor.verificationLevel >= 3 and category in ["software", "api-services"]
[x402-tiny] allow when rail == "x402" and amount <= 5
```

`amount` is always in the policy's `normalizedCurrency` (default USD); a request in USDC or
EUR is normalized via the configured FX table before comparison.

## Combining algorithm (fail closed)

Deny-overrides → require_approval → allow → **default deny**:

1. any matched `deny` statement → **deny**
2. else any matched `require_approval` → **require_approval**
3. else any matched `allow` → **allow**
4. else (nothing explicitly allowed it) → **deny**

Evaluation is pure and total — a fixed attribute set, comparison operators, no loops — so every
policy terminates and every decision returns the exact statements that fired with their evidence.

## Attributes

| Attribute | Type | Meaning |
|---|---|---|
| `amount` | number | request amount, normalized to the policy currency |
| `currency` | string | original currency/asset (USD, USDC, EUR, …) |
| `rail` | string | `x402` \| `acp` \| `card` \| `ap2` \| `sepa` \| `ach` \| `other` |
| `category` | string | normalized category (e.g. from MCC or metadata) |
| `subscription` | boolean | request flagged recurring |
| `vendor.known` | boolean | resolved to a registry vendor |
| `vendor.status` | string | `active` \| `suspended` \| `revoked` \| `unknown` |
| `vendor.verificationLevel` | number | 0–5 (V2) |
| `vendor.registryAgeDays` / `vendor.domainAgeDays` | number | age signals |
| `risk.level` / `risk.score` | string / number | V5 output (`unknown` if vendor not resolved) |
| `contract.subscription` / `.autoRenews` / `.arbitration` / `.earlyTerminationFee` | boolean | V4 extracted terms |
| `time.hourUtc` | number | 0–23 |

Operators: `==` `!=` `>` `>=` `<` `<=` `in` `not in` `exists` / `not exists`.
Ordering operators against a null/absent numeric attribute fail closed (an unknown domain age
never slips under `domainAgeDays < 90`).

## The decision flow (V12)

```
PurchaseRequest (rail-agnostic; produced by a rail adapter)
  └─ resolve principal chain (org → department → agent); suspended anywhere ⇒ deny
  └─ resolve counterparty → vendorId (by vendorId | wallet | domain)
  └─ assemble context: verification (V2), risk (V5), contract terms (V4), amount normalized
  └─ delegation gates (V9): max amount, allowed rails/categories, vendor allow/deny — narrow-only
  └─ evaluate policy (V6) → allow | deny | require_approval
  └─ if allow: place cross-rail budget holds (V6); mint signed decision token (V12)
  └─ if require_approval: park a human-approval request (V8); token minted on grant
  └─ append receipt to the org hash chain (V13)
```

The response is a `Decision` with the outcome, the full reason list (every fired rule + evidence),
the resolved vendor/verification/risk, a reproducible `contextHash`, budget hold ids, and — on
allow — a **decision token**.

## Enforcement tokens

On allow (or after approval) the service mints a short-lived Ed25519-signed token. An enforcement
point — an x402 facilitator, a card issuer's JIT hook, an A2A endpoint — verifies the signature
(offline, with the published public key) and checks the settlement stays within the token's
`maxAmount` / `currency` / `rail` / `payee` before its `expiresAt`. One token format across all
rails; this is what makes policy *enforced*, not advisory.

Fetch the public key: `GET /v1/decisions/signing-key`. Verify via SDK `verifyDecisionToken`, or
directly with any Ed25519 verifier over the `header.payload` signing input.

## Delegation (V9) & budgets (V6)

Delegation only **narrows**: an agent's authority is the intersection of every constraint along
its chain (min amount, intersect rails/categories/allowed vendors, union denied vendors). Budgets
attach to any principal and are enforced with two-phase **hold/settle** — the same normalized cap
counts a card charge and a stablecoin payment together, so agents sharing one treasury cannot both
slip under it. Holds settle on confirmation, release on cancel, and expire on TTL (fail closed).

## Receipts (V13)

Every decision, approval, and settlement appends to a per-org keccak256 hash chain
(`hash_n = keccak256(hash_{n-1} ‖ canonical(payload) ‖ n)`). Any edit breaks all later hashes;
`GET /v1/orgs/:orgId/receipts/verify` recomputes and confirms the chain. Periodic Merkle-root
anchoring onchain is a later stage.
