# Deploying (you run these; nothing here has been broadcast)

Everything has been built and tested on local anvil only. **Testnet only. Never mainnet, never
real funds.** Use a throwaway testnet key that you control. These commands broadcast
transactions, which is why they are for you to run.

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
- **Merchant.** Add `ShieldedServerScheme` and a facilitator that supports it (see x402.md).
  For Path B, nothing changes for the merchant.

## 4. Things that are deliberately NOT done

- No mainnet deployment script variant, and no real-funds configuration.
- No audit. Read docs/security.md §5 before letting anyone else use a deployment.
