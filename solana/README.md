# ACTP on Solana (Anchor)

Solana/Anchor port of the ACTP **VendorRegistry + AttestationRegistry** (V1 + V2) — the
canonical merchant-identity and verification layer, on Solana. The cross-rail decision layer
(V6–V14) is chain-agnostic and already works with Solana payments unchanged; this program is
the on-chain identity anchor for the Solana deployment.

> ⚠️ **Status: written, not yet compiled or executed in this repo's authoring environment**
> (it lacked the disk for the Solana/Anchor toolchain — see the root chat). The program and
> the full test suite are complete; run `anchor build` + `anchor test` on a machine with
> ~5 GB free to compile and execute them. Treat the tests as *specifying* behavior until you
> have run them.

## What it implements

One consolidated Anchor program (`actp_registry`) — on Solana a single multi-instruction
program is idiomatic and avoids cross-program-invocation overhead:

- **V1 identity** — `register_vendor`, `add/remove_domain`, `add/remove_wallet`,
  `set_x402_endpoint`, `set_metadata`, `set_contract_metadata`, two-step
  `transfer_ownership`/`accept_ownership`, `suspend`/`unsuspend`/`revoke`, `pause`/`unpause`.
- **V2 verification** — `grant_verifier`/`revoke_verifier`, `attest`, `vendor_sign_metadata`
  (level 4), `revoke_attestation`, `ban_attester`.

### How the Solana model differs from the EVM contracts (deliberately)

- **Uniqueness is native.** A domain/wallet claim is a PDA seeded by the domain hash / wallet
  pubkey (`[b"domain", keccak(domain)]`, `[b"wallet", pubkey]`). A duplicate claim simply fails
  to `init`. Claims of a **revoked** vendor are never closed → the identity is quarantined
  forever, matching the EVM "revocation is terminal" guarantee.
- **No EIP-712 relayed attestations.** A Solana verifier signs the transaction directly, and
  the runtime handles replay (recent blockhash), so the EVM nonce/relayer machinery is gone.
  Verifier role = existence of a `[b"verifier", pubkey]` PDA.
- **Verification level is computed off-chain** from the attestation accounts (the backend
  already does this) — the same role the EVM `verificationLevel()` convenience view played.
- **Deterministic vendor id** is identical in spirit:
  `keccak256("actp.vendor.v1" ‖ keccak256(primary_domain))`.

## Prerequisites

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI (provides solana-test-validator)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor via avm
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.31.1 && avm use 0.31.1

# a local wallet for the validator
solana-keygen new -o ~/.config/solana/id.json    # if you don't have one
```

## Build, test, deploy

```bash
cd solana
yarn install            # or: npm install

anchor keys sync        # rewrites declare_id! + Anchor.toml to your program keypair
anchor build            # compiles the SBF program + generates target/types (needed by tests)
anchor test             # spins a local validator and runs the full suite in tests/

# pure-logic unit tests (no validator, no SBF toolchain) — fastest sanity check:
cargo test -p actp-registry            # runs the domain-validation tests in src/domain.rs

# deploy to devnet (x402 supports Solana devnet with devnet USDC)
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Test coverage (`tests/actp-registry.ts`)

Mirrors the Solidity suite: config init; register + field checks; duplicate-domain and
duplicate-wallet prevention (via claim-PDA collision); invalid-domain rejection;
add/remove domain (with reuse) and primary-domain protection; owner-only edits; metadata
versioning; two-step ownership transfer; the full lifecycle state machine with terminal
revocation and identifier quarantine; guardian-only lifecycle; verifier RBAC; attestation
issue / non-verifier rejection / invalid-type + expiry-bounds rejection; vendor-signed
metadata (level 4); attestation revocation; attester ban; and pause/unpause gating.

Time-based checks that the EVM suite did on-chain (attestation *expiry deactivation*) live in
the off-chain indexer/service instead, because the Solana test validator advances real time
and cannot be warped; the on-chain program still rejects past/over-long expiries at issue.
