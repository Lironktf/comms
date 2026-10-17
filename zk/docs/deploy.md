# Deploying

**Testnet only. Never mainnet, never real funds.** Use a throwaway testnet key that you control.
The stack is live on Base Sepolia (addresses in `contracts/deployments/84532.json`, deployed
2026-10-17) and every flow has been run against it; see [Live on Base Sepolia](#5-live-on-base-sepolia).

## 0. Prerequisites (pinned toolchain)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup          # forge 1.8.x
curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
noirup -v 1.0.0-beta.25
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
bbup -v 5.2.1     # bb 5.2.1's noir submodule == noir v1.0.0-beta.25 (verified pair)
npm install       # repo root
cd zk/contracts && npm install --ignore-scripts && cd -
```

Rebuild circuits and verifiers (this is deterministic; the committed artifacts were produced by it):

```bash
zk/scripts/build-circuits.sh && (cd zk/contracts && forge build) && node zk/scripts/gen-abi.mjs
```

## 1. Base Sepolia deployment

This reuses the live Grayr registries (`contracts/deployments/base-sepolia.json`) and Circle's
Base Sepolia USDC.

```bash
cd zk/contracts
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export VENDOR_REGISTRY=0x854c3D3D610F7470C28192926dF0b227257E86fc
export ATTESTATION_REGISTRY=0xa0B4dfD191d689c84d6668096F29efe0A805AB2a
export USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export ASP_POSTMAN=<address that will publish association-set roots>
export OWNER=<pool owner: token config only; ideally a Safe>
# optional private swaps: a SwapRouter02 on Base Sepolia + a WETH address
# export SWAP_ROUTER=... ; export WETH=...

forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --sender <YOUR_ADDRESS> \
  --private-key <YOUR_TESTNET_KEY>          # or: --account <foundry keystore name>
# writes zk/contracts/deployments/84532.json
```

Gas, measured on local anvil (`broadcast/Deploy.s.sol/31337/run-latest.json`, 2026-10-17):
Poseidon2 3,408,310 · TransactVerifier 3,667,503 · PolicyPayVerifier 3,736,699 ·
BudgetInitVerifier 3,575,273 · RagequitVerifier 3,621,641 · VendorTree 1,223,532 ·
AssociationSetRegistry 483,541 · ShieldedPool **including its PaymentBook** 6,621,262 ·
token config ~50k each.
- On Base Sepolia, without registries, mocks or the swap adapter, that is **≈ 26.4M gas** in
  total, spread over several transactions. The largest single one is the pool + book at 6.6M.
- At the Base gas price read on 2026-10-17 (0.006 gwei via `cast gas-price`), that is about
  0.00016 ETH. Have ~0.001 ETH on the deployer.
- `deployments/84532.json` now also lists `paymentBook`.

Funding the deployer without a Base balance (how it was done on 2026-10-17):
1. Get Ethereum Sepolia ETH from a faucet.
2. Bridge it with a plain ETH send to Base's Sepolia L1StandardBridge. It arrived on Base Sepolia
   at the same address in about 5 minutes.

```bash
cast send 0xfd0Bf71F60660E2f608ed56e1659C450eB113120 --value 0.02ether --rpc-url https://ethereum-sepolia-rpc.publicnode.com --account <keystore>
```

With `--account`, always also pass `--sender <that address>`. Both deploy scripts default roles
and ownership to `msg.sender`, and without `--sender` Forge simulates with a placeholder address
(it refuses to broadcast, but only after showing roles granted to the wrong account).

### Post-deploy (also broadcasts)

```bash
# 1. let VendorTree category attestations work: the AttestationRegistry admin grants VERIFIER_ROLE
#    to whoever attests categories (already true for your existing verifier key)
# 2. publish verified vendors into the tree (permissionless; reads live Grayr state)
cast send $VENDOR_TREE "publish(bytes32,address)" <vendorId> <wallet> --rpc-url $BASE_SEPOLIA_RPC_URL --private-key <KEY>
# 3. run the ASP once to post the first association-set root (zk/client: AspService.publish)
```

## 2. Optional: verify Path B against real USDC first (read-only, no broadcast)

```bash
cd zk/contracts
FORK_URL=https://sepolia.base.org USDC_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e forge test --match-contract PathBFork -vv
```

## 3. Services

- **Relayer / facilitator.** `new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee})`
  with `relayer.app().listen(port)`. Fund its address with a little Base Sepolia ETH for gas; it
  is reimbursed in USDC fees. Create its viem `publicClient` with a short `pollingInterval`
  (e.g. 250 ms). viem's default of 4 s was the dominant latency in local measurements: a paid
  x402 call took 5.4 s instead of 1.45 s.
- **ASP.** `AspService` with your screening rule. Call `refresh()` and then `publish()` on new deposits.
  `refresh()` reports a change against its *local* state, so a freshly started service should
  check `AssociationSetRegistry.isValidRoot(root)` before publishing (`syncAssociationSet` in
  `client/scripts/testnet-env.ts`). Wallets need a refreshed `AspService`: without it they
  refuse to spend ("deposit label is not in the association set").
- **RPC.** `https://sepolia.base.org` caps `eth_getLogs` at 200 blocks and rate-limits (HTTP 429)
  a full sync; its load-balanced nodes can also lag a block behind a receipt. The syncs split
  log ranges to whatever the RPC accepts (`client/src/logs.ts`), but use a provider that allows
  wide ranges: `https://base-sepolia-rpc.publicnode.com` answered a 20k-block range (checked
  2026-10-17).
- **Merchant.** Add `ShieldedServerScheme` and a facilitator that supports it (see x402.md).
  For Path B, nothing changes for the merchant.

## 4. Things that are deliberately NOT done

- No mainnet deployment script variant, and no real-funds configuration.
- No audit. Read docs/security.md §5 before letting anyone else use a deployment.

## 5. Live on Base Sepolia

Run from an operator key holding VERIFIER (AttestationRegistry), POSTMAN (AssociationSetRegistry)
and GUARDIAN (VendorRegistry), funded with 0.005 ETH and 10 test USDC:

```bash
cd zk/client
TESTNET_PRIVATE_KEY=$(cat ~/.config/grayr-zk/operator-testnet.key) npx tsx scripts/testnet.ts        # setup + smoke
TESTNET_PRIVATE_KEY=$(cat ~/.config/grayr-zk/operator-testnet.key) npx tsx scripts/testnet-flows.ts  # escrow, batch, x402
```

Both are resumable: setup steps already done on-chain are skipped, and `ONLY=E,F` picks flows.
The merchant is the operator's own address, so these test the machinery, not privacy.

Passed on 2026-10-17 (every transaction is on sepolia.basescan.org; receipts in
`benchmarks/results/base-sepolia-2026-10-17.json`):

| flow | result |
|---|---|
| merchant registered, attested level 3, category set, VendorTree leaf | ✓ |
| deposits, association-set root, agent budget note | ✓ |
| refundable payment through a relayer, merchant refunds 0.40 privately | ✓ balance 2.00 → 1.40 |
| agent payment under its policy (verified vendor, caps, budget in-proof) | ✓ |
| escrow released by the payer's secret, submitted from another address | ✓ |
| escrow claimed with a partial refund; claim before `claimableAt` refused | ✓ |
| escrow expired back to the payer; claim after `expiresAt` refused | ✓ |
| plain + agent payment from two payers in one batched transaction | ✓ |
| x402 Path A over HTTP, refundable, refunded by request id | ✓ only the fee is gone |
| x402 Path B: stock `@x402/evm` exact facilitator settles real Circle USDC via the pool's EIP-1271 signature | ✓ |

Live gas matched anvil within 2% (pay 1.53M, policy pay 1.55M, refund 0.68M, escrow release
81k). Base Sepolia charged 0.006 gwei for L2 gas, so a proof-carrying payment cost ~0.0000092
ETH. Its **L1 data footprint is ~114.6k L1 gas** (the ~8 KB proof), which on Sepolia cost
3×10⁸ wei. Sepolia's L1 blob price isn't representative of mainnet: price mainnet from
`l1GasUsed` and the mainnet blob fee at the time.
