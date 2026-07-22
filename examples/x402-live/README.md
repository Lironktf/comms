# Live x402 + ACTP demo (Base Sepolia)

Proves the core thesis on a real chain: **ACTP is the pre-payment decision an agent consults
before it pays over x402.** A real x402 merchant, the real `@x402/*` v2 client/server, and the
keyless community facilitator at `https://x402.org/facilitator` — settling genuine testnet USDC
on Base Sepolia (chain 84532). The only thing ACTP-specific is a single client-side hook.

## The three pieces
- **`actp-serve.ts`** — runs the real ACTP decision engine (in-memory PGlite), seeds one verified
  merchant (`acme-cloud.example`, verification level 3, whose payTo wallet is the seller's) and an
  org→agent principal with a deny-by-default spending policy, then serves the REST API on `:8080`.
- **`seller.ts`** — a genuine x402-protected merchant on `:4021`. `GET /report` costs 0.01 USDC.
  No ACTP awareness — it's just a seller.
- **`pay.ts`** — the point of the demo. A standard x402 payer whose `onBeforePaymentCreation` hook
  (the seam the x402 spec explicitly leaves open) calls ACTP's `/v1/decisions/rail/x402` **before
  signing**. On anything but ALLOW it aborts — no signature, no settlement.

## Run it
```bash
# DENY path — blocked before signing, needs NO funding:
./run.sh --rogue

# ALLOW path — pays the verified merchant on-chain (needs a funded wallet, see below):
./run.sh
```

## Funding (only needed for the ALLOW path)
The throwaway payer wallet is in `.wallet.testnet.env` (gitignored, testnet-only). Fund its
`DEMO_ADDRESS` with:
- **Base Sepolia ETH** (gas): https://www.coinbase.com/developer-platform/products/faucet
- **Base Sepolia USDC**: https://faucet.circle.com/ → select *Base Sepolia*

Check status any time:
```bash
../../node_modules/.bin/tsx balance.ts
```

## What each outcome demonstrates
| Command | ACTP outcome | What happens |
|---|---|---|
| `./run.sh` (verified merchant, 0.01 USDC) | **ALLOW** | token minted → EIP-3009 signed → facilitator settles USDC on Base Sepolia |
| `./run.sh --rogue` (payTo → unknown wallet) | **DENY** | aborted in the pre-payment hook; no signature ever produced |
| raise the price above $5 | **REQUIRE_APPROVAL** | decision parks pending human approval; no token issued |

Seam A = the client-side pre-payment check (this demo's hook). Seam B = the facilitator-side
settle-time guard (`/v1/x402/authorize-settlement`), which `pay.ts` also calls on success to show
the same token re-verifies at settlement.
