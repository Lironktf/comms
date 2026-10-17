/**
 * Live smoke test on Base Sepolia (TESTNET ONLY). You run it; it broadcasts from YOUR key.
 *
 *   export TESTNET_PRIVATE_KEY=$(cast wallet decrypt-keystore grayr-sepolia | grep -o '0x[0-9a-fA-F]\{64\}')
 *   npx tsx scripts/testnet.ts            # from zk/client
 *   unset TESTNET_PRIVATE_KEY
 *
 * Steps (each skipped if already done):
 *   1. register your address as a test merchant in the Grayr VendorRegistry, attest it (you hold
 *      VERIFIER_ROLE), set a category, publish it into the VendorTree
 *   2. deposit 2 USDC for you (a plain shielded wallet) and 1 USDC for an agent (policy-bound)
 *   3. screen deposits and publish the association-set root (you hold POSTMAN_ROLE)
 *   4. mint the agent's budget note
 *   5. you pay the merchant 1 USDC REFUNDABLY through a relayer; the merchant refunds 0.40 privately
 *   6. the agent pays 0.50 USDC under its policy (verified vendor, caps, budget, all in the proof)
 *
 * The shielded wallets' seed lives in ~/.config/grayr-zk/testnet-seed (mode 600). The merchant is
 * your own address, so this is a smoke test of the machinery, not a privacy demo.
 * Uses ~3 USDC and ~0.0001 ETH per run.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex, type PublicClient} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {baseSepolia} from "viem/chains";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {AgentWallet, prepareBudgetInit, ShieldedWallet, type Bundle} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash, type PolicyParams} from "../src/hashes.js";
import {merchantRefund} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {attestationRegistryAbi, mockUsdcAbi, shieldedPoolAbi, vendorRegistryAbi, vendorTreeAbi} from "../src/abi.js";
import {ZK_DIR} from "../src/devnet.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const U = (x: number) => BigInt(Math.round(x * 1e6));
const $ = (x: bigint) => `${(Number(x) / 1e6).toFixed(2)} USDC`;
const tx = (h: Hex) => `https://sepolia.basescan.org/tx/${h}`;
const step = (s: string) => console.log(`\n▶ ${s}`);
const DOMAIN = "testnet-merchant.grayr.example";

const pk = process.env.TESTNET_PRIVATE_KEY as Hex | undefined;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("set TESTNET_PRIVATE_KEY (see the header of this file)");
const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({chain: baseSepolia, transport: http(RPC), pollingInterval: 1_000}) as PublicClient;
const wallet = createWalletClient({account, chain: baseSepolia, transport: http(RPC)});
if ((await publicClient.getChainId()) !== 84532) throw new Error("not Base Sepolia: refusing to run");

const dep = JSON.parse(readFileSync(join(ZK_DIR, "contracts", "deployments", "84532.json"), "utf8")) as Record<string, string>;
const pool = dep.pool as Address, usdc = dep.usdc as Address, fromBlock = BigInt(dep.deployBlock!);
const me = account.address;
console.log(`account ${me}  pool ${pool}`);
console.log(`ETH ${Number(await publicClient.getBalance({address: me})) / 1e18}  USDC ${$(await erc20(usdc, me))}`);

async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({address, abi: abi as never, functionName: functionName as never, args: args as never, account, chain: baseSepolia});
  const r = await publicClient.waitForTransactionReceipt({hash});
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${tx(hash)}`);
  return hash;
}
async function erc20(token: Address, who: Address): Promise<bigint> {
  return (await publicClient.readContract({address: token, abi: mockUsdcAbi, functionName: "balanceOf", args: [who]})) as bigint;
}

// --------------------------------------------------------------------------
step("1. test merchant: Grayr registration, attestation, VendorTree leaf");
const existing = (await publicClient.readContract({address: dep.vendorRegistry as Address, abi: vendorRegistryAbi, functionName: "vendorIdForWallet", args: [me]})) as Hex;
let vendorId = existing;
if (/^0x0+$/.test(existing)) {
  console.log("  registered:", tx(await send(dep.vendorRegistry as Address, vendorRegistryAbi, "registerVendor", [DOMAIN, [], [me], `https://${DOMAIN}/x402`, `0x${"00".repeat(32)}`, ""])));
  vendorId = (await publicClient.readContract({address: dep.vendorRegistry as Address, abi: vendorRegistryAbi, functionName: "computeVendorId", args: [DOMAIN]})) as Hex;
  const now = (await publicClient.getBlock()).timestamp;
  console.log("  attested level 3:", tx(await send(dep.attestationRegistry as Address, attestationRegistryAbi, "attest", [vendorId, 3, keccak256(toHex(`evidence:${DOMAIN}`)), now + 365n * 86400n])));
  console.log("  category 'data':", tx(await send(dep.vendorTree as Address, vendorTreeAbi, "setCategories", [vendorId, 0b010n])));
} else console.log("  already registered");
const vendors = new VendorTreeSync(publicClient, dep.vendorTree as Address, fromBlock);
await vendors.sync();
const now0 = (await publicClient.getBlock()).timestamp;
if (!vendors.leaves.some((l) => l.wallet.toLowerCase() === me.toLowerCase() && l.expiry > now0 + 3600n)) {
  console.log("  published leaf:", tx(await send(dep.vendorTree as Address, vendorTreeAbi, "publish", [vendorId, me])));
} else console.log("  leaf fresh");

// --------------------------------------------------------------------------
step("2. shielded wallets + deposits");
const seedDir = join(homedir(), ".config", "grayr-zk");
const seedFile = join(seedDir, "testnet-seed");
if (!existsSync(seedFile)) {
  mkdirSync(seedDir, {recursive: true, mode: 0o700});
  writeFileSync(seedFile, randomBytes(32).toString("hex"), {mode: 0o600});
  console.log(`  new wallet seed in ${seedFile} (testnet only; back it up if you care)`);
}
const seed = Uint8Array.from(Buffer.from(readFileSync(seedFile, "utf8").trim(), "hex"));
const prover = new Prover();
const asp = new AspService(new PoolSync(publicClient, pool, fromBlock), dep.associationSet as Address, blocklistRule([]));
const admin = deriveAdminKeys(seed);
const policy: PolicyParams = {
  adminPk: admin.adminPk, token: BigInt(usdc), maxPerPayment: U(1), maxFee: U(0.05), periodBudget: U(5), periodSeconds: 86400n,
  minVendorLevel: 2n, categoryMask: 0b010n, requireVerifiedVendor: true,
};
const base = {chainId: 84532n, pool, prover, asp};
const human = new ShieldedWallet({...base, keys: deriveSpendingKeys(seed), sync: new PoolSync(publicClient, pool, fromBlock)});
const agent = new AgentWallet({...base, keys: deriveAgentKeys(seed, 0), sync: new PoolSync(publicClient, pool, fromBlock), policy, vendors});
await human.refresh();
await agent.refresh();

async function deposit(amount: bigint, opts: {to?: ShieldedWallet["address"]; policy?: bigint} = {}) {
  const d = human.prepareDeposit(usdc, amount, opts);
  await send(usdc, mockUsdcAbi, "approve", [pool, amount]);
  return send(pool, shieldedPoolAbi, "deposit", [usdc, amount, d.inner, d.encryptedNote]);
}
if (human.balance(usdc) < U(1.5)) console.log("  you deposit 2 USDC:", tx(await deposit(U(2))));
if (agent.balance(usdc) < U(0.6)) console.log("  agent funded 1 USDC:", tx(await deposit(U(1), {to: agent.address, policy: policyHash(policy)})));

// --------------------------------------------------------------------------
step("3. association set: screen deposits, publish root");
if (await asp.refresh()) console.log("  root published:", tx(await asp.publish(wallet, publicClient)));
else console.log("  root current");

// --------------------------------------------------------------------------
const relayer = new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee: {[usdc.toLowerCase()]: 0n}});
const relay = async (b: Bundle) => (await relayer.relay(b)).txHash;
await agent.refresh();
step("4. agent budget note");
if (!agent.budgetNote()) {
  const ts = (await publicClient.getBlock()).timestamp;
  console.log("  budget minted:", tx(await relay(await prepareBudgetInit({prover, admin, policy, agent: agent.address, chainId: 84532n, pool, timestamp: ts}))));
} else console.log("  budget exists");

// --------------------------------------------------------------------------
step("5. refundable private payment + private refund");
await human.refresh();
const before = human.balance(usdc);
const t0 = Date.now();
const pay = await human.preparePayment({token: usdc, amount: U(1), recipient: me, terms: {mode: "refundable"}});
console.log(`  proof built in ${Date.now() - t0} ms`);
console.log("  paid 1.00 USDC (refundable):", tx(await relay(pay)));
await human.refresh();
const rec = human.opts.sync.payments.get((pay as Extract<Bundle, {kind: "pay"}>).inputs.nullifiers[0])!;
console.log("  merchant refunds 0.40:", tx((await merchantRefund(wallet, publicClient, pool, rec, U(0.4))).hash));
await human.refresh();
console.log(`  shielded balance ${$(before)} → ${$(human.balance(usdc))} (expected −0.60)`);

// --------------------------------------------------------------------------
step("6. agent pays under its policy");
await agent.refresh();
const ab = await agent.preparePolicyPayment({amount: U(0.5), recipient: me});
console.log("  agent paid 0.50 USDC:", tx(await relay(ab)));
await agent.refresh();
const bn = agent.budgetNote()!.note;
console.log(`  agent balance ${$(agent.balance(usdc))}, budget left today ${$(bn.kind === "budget" ? bn.remaining : 0n)}`);

await prover.destroy();
console.log("\nDone. Every step above is a Base Sepolia transaction you can open on basescan.");
