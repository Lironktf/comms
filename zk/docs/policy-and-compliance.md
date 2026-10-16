# Spending policies and compliance

## Spending policies (M3)

### The insight: the adversary is the agent itself

- An agent that holds the spending key of its notes could simply use the unrestricted `transact`
  circuit and ignore any policy. So the policy must be **inside the note**:
  `inner = H3(owner, blinding, policy)`.
- `transact` refuses policy notes unless the **admin key** (the human) is presented.
- The only circuit that accepts policy notes without the admin key is `policy_pay`, which enforces
  the policy.

### Policy parameters (hashed into `policy`)

| field | meaning |
|---|---|
| `admin_pk` | the human controlling the agent (`H3(ADMIN, adminSk, 0)`) |
| `token` | the only token the agent may spend |
| `max_per_payment` | cap per payment |
| `max_fee` | cap on relayer fee per payment (stops an agent self-dealing the budget away as "fees") |
| `period_budget`, `period_seconds` | e.g. $500 per 30 days |
| `min_vendor_level` | Grayr verification level the merchant must hold (0–5) |
| `category_mask` | allowed merchant categories (bitmask); 0 = any |
| `require_verified_vendor` | true: only Grayr-verified vendors (level + category apply); false: any recipient, with caps + budget still enforced |

**`require_verified_vendor` is the one policy bit that becomes public.** The contract has to know
whether to live-check the recipient against the Grayr registry, so `policy_pay` exposes
`vendorChecked` and the circuit asserts it equals the private flag.
- When it is false, the contract requires `vendorRoot == 0`, and the vendor-tree checks are skipped.
- An agent whose policy requires verification cannot claim `vendorChecked = false`: the proof
  fails (tested).

The policy is private: it never appears on-chain, only inside commitments.

### Verified merchants: VendorTree (Grayr integration)

- Circuits can't call the AttestationRegistry. So `VendorTree.publish(vendorId, wallet)` (anyone
  may call it) reads Grayr's **live** registry state, i.e. Active status, the wallet→vendor
  binding and the computed verification level, and inserts a Poseidon2 leaf
  `H3(VENDOR, wallet, H3(level, categories, expiry))`.
- The circuit proves the recipient has such a leaf with `level ≥ min_vendor_level`, an allowed
  category and `expiry ≥ now`.
- **Freshness:**
  - Leaves expire after 7 days (ASSUMPTION; set by Grayr's revocation SLA), so a level demotion
    stops working within that time.
  - **Suspension and revocation are instant**, because the pool also checks
    `VendorRegistry.vendorStatus(vendorIdForWallet(recipient)) == Active` at payment time. The
    recipient is public, so this check costs no privacy.
- Categories aren't on-chain in Grayr V1 (they live in V3 metadata). They are attested into
  VendorTree by holders of the AttestationRegistry's `VERIFIER_ROLE`, the same parties already
  trusted for levels.
- VendorTree is a separate contract that only *reads* the deployed registries, so the live Base
  Sepolia Grayr deployment needs no upgrade.

### The private budget note

- A budget note is `(remaining, period, owner, blinding, policy)` in its own hash domain.
- **Creation:** only `budget_init`, which needs the admin key and holds exactly `period_budget`
  for the current period. The contract rejects re-submission of the same commitment.
- **Spending:** every `policy_pay` consumes the budget note and creates exactly one successor:
  - `period_now = now / period_seconds`, and the circuit asserts `period_now ≥ budget.period`;
  - `available = period_now > budget.period ? period_budget : remaining`  (automatic rollover);
  - `amount + fee ≤ available`;
  - the new note holds `available − amount − fee` for `period_now`.
- **No double-spending across periods:**
  - Lineages never fork (one in, one out).
  - Periods can't go backwards.
  - `now` can't be in the future (contract check) and is at most 1 h stale.
- **No forging:** a budget commitment can only come from budget_init (admin) or policy_pay
  (1-for-1). Deposits and transact outputs are always in the NOTE domain.

### The human's controls

- Fund the agent: `prepareDeposit(token, amount, {to: agent.address, policy})`, or a private
  transfer with `policy`.
- Mint or refresh budget: `prepareBudgetInit`. Rotating to a new policy means new notes and a new
  budget.
- Sweep: an `AgentWallet` constructed with `admin` keys spends policy notes through `transact`.

## Compliance (M5): association sets + ragequit (Privacy Pools model)

- **Labels.** Each deposit gets an on-chain label. Every descendant note keeps it, because all
  notes in a transaction share one label.
- **Association set provider (ASP).**
  - `AspService` screens deposits with a pluggable rule (e.g. a sanctions-list snapshot;
    `blocklistRule` in the demo).
  - It builds the Poseidon2 tree of approved labels and posts the root plus a content address of
    the label list to `AssociationSetRegistry`.
  - Private spends must prove `label ∈ latest root`, with a 10-minute grace for the previous root
    (ASSUMPTION: covers proof + relay latency).
- **Exclusion.** A label removed from the set stops moving privately within the grace window.
- **Ragequit.** The owner proves ownership of a note and the pool pays `depositorOf[label]`
  publicly. Funds can't go anywhere else, and nobody, including the ASP, can trap them. Anyone can
  submit a ragequit; only the depositor gets paid.
- **Why from day one.**
  - USDC can be blacklisted by Circle. A pool that mixes in sanctioned funds risks its whole
    address being frozen.
  - The Tornado Cash prosecutions show that "we just wrote code" is not a sufficient posture.
  - Association sets let honest users prove disassociation from bad deposits without revealing
    which deposit is theirs.

### Threshold view keys (design only, not built)

Goal: a regulator can see specific transactions under legal process, but no single party can look.

1. Each note ciphertext gets an extra recipient: the note key is encrypted to a **threshold**
   public key `Y = Σ λ_i·Y_i` held by k-of-n custodians (e.g. a court, an auditor, Grayr, an NGO).
   This could use threshold ElGamal on Grumpkin, which is cheap to prove in Noir.
2. The circuit must prove the escrow ciphertext is well-formed (the same note, encrypted to Y).
   Otherwise a user could escrow garbage. This is the expensive part, roughly +1–2k gates.
3. Decryption needs k custodians to each produce a partial decryption for one specific
   ciphertext. Requests and partials are logged on-chain, giving a transparency log of every
   lookup.
4. Selective: one transaction at a time. The custodians never hold users' spending keys.

The open questions are custodian selection, revocation, and whether the escrow ciphertext's
existence leaks anything. Not built; listed in future-research.md.
