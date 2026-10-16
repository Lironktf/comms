/**
 * One-command local demo:   npm run demo -w zk/client
 * Spins up anvil, deploys everything, and walks an AI agent through private x402 payments.
 * LOCAL ONLY (anvil test keys); nothing touches a real network.
 */
import express from "express";
import type {Server} from "node:http";
import {decodeEventLog, type Address} from "viem";
import {x402Client} from "@x402/core/client";
import {x402ResourceServer} from "@x402/core/server";
import {x402Facilitator} from "@x402/core/facilitator";
import {paymentMiddleware} from "@x402/express";
import {wrapFetchWithPayment, decodePaymentResponseHeader} from "@x402/fetch";
import {ExactEvmScheme as ExactServer} from "@x402/evm/exact/server";
import {ExactEvmScheme as ExactFacilitator} from "@x402/evm/exact/facilitator";
import {toFacilitatorEvmSigner} from "@x402/evm";
import {approve, erc20Balance, mintUsdc, registerVerifiedVendor, startDevnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {AgentWallet, prepareBudgetInit, ShieldedWallet} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash, type PolicyParams} from "../src/hashes.js";
import {submitBundle} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {shieldedPoolAbi} from "../src/abi.js";
import {localFacilitatorClient, PoolExactClientScheme, ShieldedClientScheme, ShieldedFacilitatorScheme, ShieldedServerScheme} from "../src/x402/index.js";

const NET = "eip155:31337" as const;
const $ = (x: bigint) => `$${(Number(x) / 1e6).toFixed(2)}`;
const U = (x: number) => BigInt(Math.round(x * 1e6));
const step = (s: string) => console.log(`\n\x1b[1m▶ ${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const servers: Server[] = [];
const listen = (app: express.Express) =>
  new Promise<string>((r) => {
    const s = app.listen(0, () => r(`http://127.0.0.1:${(s.address() as {port: number}).port}`));
    servers.push(s);
  });

step("Local chain: anvil + ShieldedPool + Grayr registries + verifiers");
const d = await startDevnet(8700);
const prover = new Prover();
const HUMAN = 1, RELAYER = 2, WEATHER = 4, LEGACY = 5, FAC_B = 6;
ok(`pool ${d.deployment.pool}`);

const asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([d.address(9)]));
const relayer = new Relayer({pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(RELAYER), publicClient: d.publicClient, minFee: {[d.deployment.usdc.toLowerCase()]: U(0.01)}});

step("Grayr verifies a merchant: api.weather.example (level 3, category 'data')");
await registerVerifiedVendor(d, {owner: WEATHER, domain: "api.weather.example", wallet: d.address(WEATHER), level: 3, categories: 0b010n});
ok("registered in VendorRegistry, attested level 3, published into VendorTree");

step("The human sets an agent policy: ≤ $1/payment, ≤ $2/day, verified level ≥ 2, category 'data'");
const seed = new Uint8Array(32).fill(42);
const admin = deriveAdminKeys(seed);
const policy: PolicyParams = {adminPk: admin.adminPk, token: BigInt(d.deployment.usdc), maxPerPayment: U(1), maxFee: U(0.02), periodBudget: U(2), periodSeconds: 86400n, minVendorLevel: 2n, categoryMask: 0b010n, requireVerifiedVendor: true};
const base = {chainId: 31337n, pool: d.deployment.pool, prover, asp};
const human = new ShieldedWallet({...base, keys: deriveSpendingKeys(seed), sync: new PoolSync(d.publicClient, d.deployment.pool)});
const agent = new AgentWallet({...base, keys: deriveAgentKeys(seed, 0), sync: new PoolSync(d.publicClient, d.deployment.pool), policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree)});

step("Human deposits $20 straight into the agent's policy-bound balance (public: 'someone deposited $20')");
await mintUsdc(d, d.address(HUMAN), U(20));
await approve(d, HUMAN, d.deployment.usdc, d.deployment.pool, U(20));
const dep = human.prepareDeposit(d.deployment.usdc, U(20), {to: agent.address, policy: policyHash(policy)});
const hw = d.wallet(HUMAN);
await d.publicClient.waitForTransactionReceipt({hash: await hw.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, U(20), dep.inner, dep.encryptedNote], account: hw.account!, chain: d.chain})});
await asp.refresh();
await asp.publish(d.wallet(0), d.publicClient);
ok("association-set provider screened the deposit and published a new root");
await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, await prepareBudgetInit({prover, admin, policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: (await d.publicClient.getBlock()).timestamp}));
await agent.refresh();
ok(`agent sees: balance ${$(agent.balance(d.deployment.usdc))}, budget ${$((agent.budgetNote()!.note as {remaining: bigint}).remaining)} today (nobody else can see either)`);

step("Merchant runs an x402 API with the `shielded` scheme (Path A)");
const relayerUrl = await listen(relayer.app());
const fac = new x402Facilitator().register(NET, new ShieldedFacilitatorScheme(relayer, {network: NET, token: d.deployment.usdc, publicUrl: relayerUrl}));
const rs = new x402ResourceServer(localFacilitatorClient(fac)).register(NET, new ShieldedServerScheme({usdc: d.deployment.usdc}));
const app = express();
app.use(paymentMiddleware({"GET /forecast": {accepts: {scheme: "shielded", network: NET, payTo: d.address(WEATHER), price: {amount: U(0.5).toString(), asset: d.deployment.usdc}, maxTimeoutSeconds: 300}, description: "forecast"}} as never, rs));
app.get("/forecast", (_q, r) => void r.json({city: "Waterloo", forecast: "snow"}));
const url = await listen(app);
ok(`GET ${url}/forecast costs $0.50`);

step("Agent calls the API 3 times; each call = 402 → ZK proof (policy enforced inside) → paid → 200");
const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, new ShieldedClientScheme({wallet: agent, maxFee: U(0.02)})));
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  const res = await pay(`${url}/forecast`);
  const tx = decodePaymentResponseHeader(res.headers.get("payment-response")!).transaction;
  ok(`call ${i}: HTTP ${res.status} ${JSON.stringify(await res.json())} in ${Date.now() - t0} ms (tx ${tx.slice(0, 10)}…)`);
}
await agent.refresh();
ok(`merchant received ${$(await erc20Balance(d, d.deployment.usdc, d.address(WEATHER)))}; agent budget left today: ${$((agent.budgetNote()!.note as {remaining: bigint}).remaining)}`);

step("Agent tries a 4th call: over its private daily budget");
try {
  await pay(`${url}/forecast`);
  no("paid (unexpected)");
} catch (e) {
  ok(`refused: ${(e as Error).message.replace(/^.*?policy: /, "policy: ")}`);
}

step("What the public chain shows for those payments");
const logs = await d.publicClient.getLogs({address: d.deployment.pool, fromBlock: 0n});
for (const l of logs) {
  try {
    const e = decodeEventLog({abi: shieldedPoolAbi, data: l.data, topics: l.topics});
    if (e.eventName === "PublicPayment") console.log(`  pool paid ${(e.args as {recipient: Address}).recipient} ${$((e.args as {amount: bigint}).amount)}  (payer: unknown)`);
  } catch { /* not an ABI event */ }
}

step("Path B: a LEGACY x402 merchant (stock @x402/evm `exact`, zero changes) gets paid by the pool");
const fw = d.wallet(FAC_B);
const signer = toFacilitatorEvmSigner({
  address: fw.account!.address, readContract: (a) => d.publicClient.readContract(a as never), verifyTypedData: (a) => d.publicClient.verifyTypedData(a as never),
  writeContract: (a) => fw.writeContract({...(a as object), account: fw.account!, chain: d.chain} as never), sendTransaction: (a) => fw.sendTransaction({...a, account: fw.account!, chain: d.chain}),
  waitForTransactionReceipt: (a) => d.publicClient.waitForTransactionReceipt(a), getCode: (a) => d.publicClient.getCode(a),
});
const legacyRs = new x402ResourceServer(localFacilitatorClient(new x402Facilitator().register(NET, new ExactFacilitator(signer)))).register(NET, new ExactServer());
const app2 = express();
app2.use(paymentMiddleware({"GET /quote": {accepts: {scheme: "exact", network: NET, payTo: d.address(LEGACY), maxTimeoutSeconds: 300, price: {amount: U(1).toString(), asset: d.deployment.usdc, extra: {name: "USDC", version: "2"}}}, description: "quote"}} as never, legacyRs));
app2.get("/quote", (_q, r) => void r.json({quote: 42}));
const url2 = await listen(app2);
await mintUsdc(d, d.address(HUMAN), U(5));
await approve(d, HUMAN, d.deployment.usdc, d.deployment.pool, U(5));
const dep2 = human.prepareDeposit(d.deployment.usdc, U(5));
await d.publicClient.waitForTransactionReceipt({hash: await hw.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, U(5), dep2.inner, dep2.encryptedNote], account: hw.account!, chain: d.chain})});
await asp.refresh();
await asp.publish(d.wallet(0), d.publicClient);
const payB = wrapFetchWithPayment(fetch, new x402Client().register(NET, new PoolExactClientScheme({wallet: human, fee: U(0.01), feeRecipient: relayer.address, publicClient: d.publicClient, relay: (b) => relayer.relay(b)})));
const r2 = await payB(`${url2}/quote`);
ok(`HTTP ${r2.status} ${JSON.stringify(await r2.json())}; legacy merchant received ${$(await erc20Balance(d, d.deployment.usdc, d.address(LEGACY)))} via EIP-1271 from the pool`);

console.log("\nDone. Everything ran on a local anvil.\n");
for (const s of servers) s.close();
await prover.destroy();
d.stop();
process.exit(0);
