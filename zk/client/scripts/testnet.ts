/**
 * Live smoke test on Base Sepolia (TESTNET ONLY). Broadcasts from TESTNET_PRIVATE_KEY.
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
import {keccak256, toHex, type Address, type Hex} from "viem";
import {prepareBudgetInit, type Bundle, type ShieldedWallet} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash} from "../src/hashes.js";
import {merchantRefund} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {attestationRegistryAbi, mockUsdcAbi, shieldedPoolAbi, vendorRegistryAbi, vendorTreeAbi} from "../src/abi.js";
import {$, DOMAIN, dep, fromBlock, me, openWallets, pool, syncAssociationSet, publicClient, read, send, step, tx, U, usdc, wallet} from "./testnet-env.js";

// --------------------------------------------------------------------------
step("1. test merchant: Grayr registration, attestation, VendorTree leaf");
const vendorId = (await read(dep.vendorRegistry as Address, vendorRegistryAbi, "computeVendorId", [DOMAIN])) as Hex;
// each sub-step is checked onchain, so a run interrupted halfway resumes where it stopped
if (/^0x0+$/.test((await read(dep.vendorRegistry as Address, vendorRegistryAbi, "vendorIdForWallet", [me])) as Hex)) {
  console.log("  registered:", tx(await send(dep.vendorRegistry as Address, vendorRegistryAbi, "registerVendor", [DOMAIN, [], [me], `https://${DOMAIN}/x402`, `0x${"00".repeat(32)}`, ""])));
} else console.log("  already registered");
if (Number(await read(dep.attestationRegistry as Address, attestationRegistryAbi, "verificationLevel", [vendorId])) < 3) {
  const now = (await publicClient.getBlock()).timestamp;
  console.log("  attested level 3:", tx(await send(dep.attestationRegistry as Address, attestationRegistryAbi, "attest", [vendorId, 3, keccak256(toHex(`evidence:${DOMAIN}`)), now + 365n * 86400n])));
} else console.log("  already level 3");
if (((await read(dep.vendorTree as Address, vendorTreeAbi, "categoriesOf", [vendorId])) as bigint) !== 0b010n) {
  console.log("  category 'data':", tx(await send(dep.vendorTree as Address, vendorTreeAbi, "setCategories", [vendorId, 0b010n])));
} else console.log("  category set");
const vendors = new VendorTreeSync(publicClient, dep.vendorTree as Address, fromBlock);
await vendors.sync();
const now0 = (await publicClient.getBlock()).timestamp;
if (!vendors.leaves.some((l) => l.wallet.toLowerCase() === me.toLowerCase() && l.expiry > now0 + 3600n)) {
  console.log("  published leaf:", tx(await send(dep.vendorTree as Address, vendorTreeAbi, "publish", [vendorId, me])));
} else console.log("  leaf fresh");

// --------------------------------------------------------------------------
step("2. shielded wallets + deposits");
const {prover, asp, admin, policy, human, agent} = await openWallets();

async function deposit(amount: bigint, opts: {to?: ShieldedWallet["address"]; policy?: bigint} = {}) {
  const d = human.prepareDeposit(usdc, amount, opts);
  await send(usdc, mockUsdcAbi, "approve", [pool, amount]);
  return send(pool, shieldedPoolAbi, "deposit", [usdc, amount, d.inner, d.encryptedNote]);
}
if (human.balance(usdc) < U(1.5)) console.log("  you deposit 2 USDC:", tx(await deposit(U(2))));
if (agent.balance(usdc) < U(0.6)) console.log("  agent funded 1 USDC:", tx(await deposit(U(1), {to: agent.address, policy: policyHash(policy)})));

// --------------------------------------------------------------------------
step("3. association set: screen deposits, publish root");
const aspTx = await syncAssociationSet(asp);
console.log(aspTx ? `  root published: ${tx(aspTx)}` : "  root current");

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
