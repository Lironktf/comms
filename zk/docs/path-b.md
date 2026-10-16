# Path B: the pool as a standard x402 `exact` payer (verified)

**Question:** can an unmodified x402 merchant be paid privately, if the payer (`from`) of a USDC
EIP-3009 `transferWithAuthorization` is a smart contract that answers EIP-1271?

**Answer: yes, on Base mainnet and Base Sepolia.** It is verified three ways: source code,
deployed bytecode, and execution of the real contract on a local fork.

## 1. USDC FiatToken source (circlefin/stablecoin-evm, FiatTokenV2_2)

- `FiatTokenV2_2.sol` adds an overload
  `transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)`.
  The older `(…, uint8 v, bytes32 r, bytes32 s)` overload re-packs to `r‖s‖v` and goes down the
  same path.
- `EIP3009.sol` builds the digest as
  `MessageHashUtils.toTypedDataHash(_domainSeparator(), keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)))`,
  with `TRANSFER_WITH_AUTHORIZATION_TYPEHASH = 0x7c7c6cdb…2267`, and checks it with
  `SignatureChecker.isValidSignatureNow(from, digest, signature)`.
- `SignatureChecker.sol` branches **once** on `from`'s code size:
  - no code → ECDSA recover;
  - code → `staticcall isValidSignature(digest, signature)`, valid iff it returns `0x1626ba7e`.
  - It does not fall back from one to the other.

## 2. Deployed bytecode (read-only `eth_call` / `eth_getStorageAt`)

| | Base mainnet `0x8335…2913` | Base Sepolia `0x036C…CF7e` |
|---|---|---|
| `version()` | "2" | "2" |
| `name()` (EIP-712 domain name) | "USD Coin" | "USDC" |
| implementation (legacy proxy slot) | `0x2ce6311ddae708829bc0784c967b7d77d19fd779` | `0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5` |
| `transferWithAuthorization(…,bytes)` selector `0xcf092995` in implementation | present | present |
| linked SignatureChecker library contains `0x1626ba7e` | yes (`0x2d94…691e`) | yes (`0xba3b…7da6`) |

## 3. Executed against the real contract (local fork, nothing broadcast)

`contracts/test/PathBFork.t.sol` forks the chain, deploys the pool, funds it with a normal deposit,
calls `authorizeTransfer`, and then calls the **real** USDC's
`transferWithAuthorization(from = pool, …, bytes signature)` as a stranger:

```
FORK_URL=https://sepolia.base.org USDC_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e forge test --match-contract PathBFork -vv
FORK_URL=https://mainnet.base.org USDC_ADDR=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 forge test --match-contract PathBFork -vv
```

Both pass (run 2026-10-16): the transfer executes, `authorizationState(pool, nonce)` becomes
true, and an unregistered authorization reverts with `FiatTokenV2: invalid signature`.

## 4. The unmodified x402 facilitator (@x402/evm 2.19.0, also checked in 2.28.0)

- **verify** (`verifyTypedDataSignature`): calls `getCode(from)`. Because the pool has code, it
  calls `isValidSignature(digest, signature)` and accepts if the result starts with `0x1626ba7e`.
  It then `eth_call`-simulates the transfer.
- **settle** (`executeTransferWithAuthorization`):
  - a signature of exactly 65 bytes is split into v, r, s;
  - anything else is sent to the `bytes` overload.
  - So the agent sends a non-65-byte marker (`POOL_SIGNATURE`, 19 bytes), which the pool ignores.
- **settle runs verify again** before sending, so the digest must stay registered until the
  transaction lands. `isValidSignature` is a pure view, so this is safe.
- **The e2e test** (`client/test/x402.e2e.test.ts`, "Path B") runs the stock `ExactEvmScheme`
  server + facilitator from `@x402/evm` against the pool on anvil, and the merchant gets paid.
- **Not verified:** the exact code behind the hosted `x402.org/facilitator`.

## 5. Design (ShieldedPool.authorizeTransfer / isValidSignature / reclaimAuthorization)

1. The agent proves a `transact` in **deferred** mode: `publicAmount = X`, `recipient = M`, change
   to itself, and out1 = the core of a refund note worth X. The context binds `validAfter`,
   `validBefore` and `nonce`.
2. A relayer calls `authorizeTransfer`. The pool verifies the proof, records the nullifiers,
   inserts the change, **computes the TransferWithAuthorization digest itself** (with USDC's own
   `DOMAIN_SEPARATOR()`), and stores it as pending. The relayer is paid its fee immediately.
3. The agent sends the merchant a normal `exact` payload
   `{from: pool, to: M, value: X, validAfter, validBefore, nonce}` with the marker signature.
4. The merchant's facilitator settles. USDC asks `pool.isValidSignature(digest)`, which answers
   yes only while the digest is pending, not closed, and before `validBefore`.

**Safety:**
- **Exactness.** A different amount, recipient or nonce gives a different digest, which the pool
  rejects (tested).
- **Single use.** USDC's nonce prevents a second execution.
- **No refund + payment.** USDC requires `block.timestamp < validBefore`, while `reclaim` requires
  `≥ validBefore` **and** `authorizationState == false`.
- **No double refund.** The `closed` flag.
- **Window.** `validBefore ≤ now + 1 h` (ASSUMPTION; x402 `maxTimeoutSeconds` is typically ≤ 300 s).
- **No signature confusion.** The pool never signs a raw hash, only digests it computed for
  `TransferWithAuthorization(from = pool, …)`. It can't be tricked into approving a `permit`, a
  `cancelAuthorization` or another protocol's message.

**Costs and caveats:**
- Two transactions (authorize, then the merchant's settle) instead of one.
- The relayer is paid at authorize time even if the merchant never settles. The refund path then
  returns X, but not the fee.
- Path B works for any token with the same EIP-3009 + EIP-1271 semantics. The pool enables it per
  token (`eip3009` flag).
