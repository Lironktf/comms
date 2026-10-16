/**
 * M3 end to end: an AGENT with a cryptographically enforced spending policy.
 * The human (policy admin) funds the agent and mints its budget; the agent can only pay
 * Grayr-verified vendors at level >= 2 in allowed categories, <= 10 USDC per payment,
 * <= 20 USDC per 30-day period. Every violation is shown to fail IN THE CIRCUIT.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {Address} from "viem";
import {approve, erc20Balance, increaseTime, mintUsdc, publishVendor, registerVerifiedVendor, startDevnet, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {AgentWallet, prepareBudgetInit, ShieldedWallet, type Bundle} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash, type PolicyParams} from "../src/hashes.js";
import {simulateBundle, submitBundle} from "../src/pool.js";
import {shieldedPoolAbi, vendorRegistryAbi} from "../src/abi.js";

const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const HUMAN_SEED = new Uint8Array(32).fill(9);
const HUMAN = 1, RELAYER = 2, MERCH_A = 4, MERCH_B = 5, MERCH_C = 6;

let d: Devnet;
let prover: Prover;
let asp: AspService;
let human: ShieldedWallet;
let agent: AgentWallet;
let policy: PolicyParams;
let merchA: Address, merchB: Address, merchC: Address, unverified: Address;

const relay = (b: Bundle) => submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, b);
const now = async () => (await d.publicClient.getBlock()).timestamp;

beforeAll(async () => {
  d = await startDevnet(8612);
  prover = new Prover();
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
  [merchA, merchB, merchC, unverified] = [d.address(MERCH_A), d.address(MERCH_B), d.address(MERCH_C), d.address(9)];

  // Grayr registry: A = level 3, category bit 1 (allowed); B = level 1 (too low); C = level 3, bit 0 (not allowed)
  await registerVerifiedVendor(d, {owner: MERCH_A, domain: "api.alpha.example", wallet: merchA, level: 3, categories: 0b010n});
  await registerVerifiedVendor(d, {owner: MERCH_B, domain: "api.beta.example", wallet: merchB, level: 1, categories: 0b010n});
  await registerVerifiedVendor(d, {owner: MERCH_C, domain: "api.gamma.example", wallet: merchC, level: 3, categories: 0b001n});

  const admin = deriveAdminKeys(HUMAN_SEED);
  policy = {
    adminPk: admin.adminPk, token: BigInt(d.deployment.usdc), maxPerPayment: USDC(10), maxFee: USDC(0.05),
    periodBudget: USDC(20), periodSeconds: 30n * 86400n, minVendorLevel: 2n, categoryMask: 0b110n, requireVerifiedVendor: true,
  };
  const base = {chainId: 31337n, pool: d.deployment.pool, prover, asp};
  human = new ShieldedWallet({...base, keys: deriveSpendingKeys(HUMAN_SEED), sync: new PoolSync(d.publicClient, d.deployment.pool)});
  agent = new AgentWallet({
    ...base, keys: deriveAgentKeys(HUMAN_SEED, 0), sync: new PoolSync(d.publicClient, d.deployment.pool),
    policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree),
  });
});

afterAll(async () => {
  await prover?.destroy();
  d?.stop();
});

describe("agent spending policy (real proofs)", () => {
  it("human funds the agent's policy-bound notes with one deposit", async () => {
    await mintUsdc(d, d.address(HUMAN), USDC(100));
    await approve(d, HUMAN, d.deployment.usdc, d.deployment.pool, USDC(100));
    const dep = human.prepareDeposit(d.deployment.usdc, USDC(100), {to: agent.address, policy: policyHash(policy)});
    const w = d.wallet(HUMAN);
    await d.publicClient.waitForTransactionReceipt({
      hash: await w.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, USDC(100), dep.inner, dep.encryptedNote], account: w.account!, chain: d.chain}),
    });
    if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
    await agent.refresh();
    expect(agent.balance(d.deployment.usdc)).toBe(USDC(100));
  });

  let initBundle: Bundle;
  it("human (policy admin) mints the agent's budget note", async () => {
    initBundle = await prepareBudgetInit({
      prover, admin: deriveAdminKeys(HUMAN_SEED), policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: await now(),
    });
    const {gasUsed} = await relay(initBundle);
    console.log(`  initBudget gas: ${gasUsed}`);
    await agent.refresh();
    expect(agent.budgetNote()?.note.kind === "budget" && agent.budgetNote()!.note.remaining).toBe(USDC(20));
  });

  it("the budget-init proof can't be replayed to mint a second budget", async () => {
    await expect(simulateBundle(d.publicClient, d.deployment.pool, initBundle, d.address(RELAYER))).rejects.toThrow(/BudgetAlreadyInitialized/);
  });

  it("only the admin can mint budget: a forged admin key fails in the circuit", async () => {
    await expect(
      prepareBudgetInit({prover, admin: {adminSk: 123n, adminPk: policy.adminPk}, policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: await now()}),
    ).rejects.toThrow(/not the policy admin|admin key does not control/);
  });

  it("agent pays a verified level-3 merchant within caps", async () => {
    const before = await erc20Balance(d, d.deployment.usdc, merchA);
    const b = await agent.preparePolicyPayment({amount: USDC(8), recipient: merchA, fee: USDC(0.02), feeRecipient: d.address(RELAYER)});
    const {gasUsed} = await relay(b);
    console.log(`  payWithPolicy gas: ${gasUsed}`);
    expect(await erc20Balance(d, d.deployment.usdc, merchA)).toBe(before + USDC(8));
    await agent.refresh();
    expect(agent.budgetNote()!.note.kind === "budget" && agent.budgetNote()!.note.remaining).toBe(USDC(11.98));
    expect(agent.balance(d.deployment.usdc)).toBe(USDC(91.98));
  });

  describe("violations are rejected by the circuit (client precheck disabled)", () => {
    const pay = (amount: bigint, recipient: Address, fee = 0n) =>
      agent.preparePolicyPayment({amount, recipient, fee, feeRecipient: d.address(RELAYER), unsafeSkipPolicyPrecheck: true});
    it("over the per-payment cap", () => expect(pay(USDC(10.5), merchA)).rejects.toThrow(/over per-payment cap/));
    it("fee over cap", () => expect(pay(USDC(1), merchA, USDC(0.06))).rejects.toThrow(/fee over cap/));
    it("over the period budget", async () => {
      // 11.98 left: spend 10.05 of it (allowed), then 2 more is over budget
      await relay(await pay(USDC(10), merchA, USDC(0.05)));
      await expect(pay(USDC(2), merchA)).rejects.toThrow(/over budget/);
    });
    it("merchant below the required verification level", () => expect(pay(USDC(1), merchB)).rejects.toThrow(/merchant level too low/));
    it("merchant category not allowed", () => expect(pay(USDC(1), merchC)).rejects.toThrow(/category not allowed/));
    it("unverified merchant", () => expect(pay(USDC(1), unverified)).rejects.toThrow(/merchant not verified/));
  });

  it("an agent whose policy requires verified vendors can't flip the public vendorChecked bit", async () => {
    const b = (await agent.preparePolicyPayment({amount: USDC(1), recipient: merchA})) as Extract<Bundle, {kind: "policyPay"}>;
    const sim = (x: Bundle) => simulateBundle(d.publicClient, d.deployment.pool, x, d.address(RELAYER));
    await expect(sim({...b, inputs: {...b.inputs, vendorChecked: false, vendorRoot: 0n}})).rejects.toThrow(/InvalidProof/);
    await expect(sim({...b, inputs: {...b.inputs, vendorChecked: false}})).rejects.toThrow(/UnknownVendorRoot/);
  });

  it("the agent can't bypass the policy through the plain transact circuit", async () => {
    await expect(agent.preparePayment({token: d.deployment.usdc, amount: USDC(1), recipient: unverified})).rejects.toThrow(/policy_pay|admin key/);
  });

  it("budget rolls over to a fresh period automatically, never earlier", async () => {
    await expect(agent.preparePolicyPayment({amount: USDC(5), recipient: merchA})).rejects.toThrow(/over budget/);
    await increaseTime(d, 30 * 86400);
    // 30 days > the 7-day vendor-leaf TTL, so merchant A's leaf has expired: the agent's
    // client refuses until the leaf is refreshed (a keeper / the merchant re-publishes).
    await expect(agent.preparePolicyPayment({amount: USDC(5), recipient: merchA})).rejects.toThrow(/not a verified vendor/);
    await publishVendor(d, merchA);
    const b = await agent.preparePolicyPayment({amount: USDC(5), recipient: merchA});
    await relay(b);
    await agent.refresh();
    expect(agent.budgetNote()!.note.kind === "budget" && agent.budgetNote()!.note.remaining).toBe(USDC(15));
  });

  it("suspending a vendor in Grayr blocks payments to it immediately (live registry check)", async () => {
    const b = await agent.preparePolicyPayment({amount: USDC(1), recipient: merchA});
    const vendorId = await d.publicClient.readContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "vendorIdForWallet", args: [merchA]});
    const g = d.wallet(0);
    await d.publicClient.waitForTransactionReceipt({
      hash: await g.writeContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "suspendVendor", args: [vendorId, "incident"], account: g.account!, chain: d.chain}),
    });
    await expect(simulateBundle(d.publicClient, d.deployment.pool, b, d.address(RELAYER))).rejects.toThrow(/VendorNotActive/);
  });

  it("a policy WITHOUT requireVerifiedVendor pays any address; caps and budget still bind", async () => {
    const seed2 = new Uint8Array(32).fill(10);
    const admin2 = deriveAdminKeys(seed2);
    const open: PolicyParams = {...policy, adminPk: admin2.adminPk, requireVerifiedVendor: false};
    const agent2 = new AgentWallet({
      chainId: 31337n, pool: d.deployment.pool, prover, asp, keys: deriveAgentKeys(seed2, 0),
      sync: new PoolSync(d.publicClient, d.deployment.pool), policy: open, // no VendorTreeSync needed
    });
    await mintUsdc(d, d.address(HUMAN), USDC(30));
    await approve(d, HUMAN, d.deployment.usdc, d.deployment.pool, USDC(30));
    const dep = human.prepareDeposit(d.deployment.usdc, USDC(30), {to: agent2.address, policy: policyHash(open)});
    const w = d.wallet(HUMAN);
    await d.publicClient.waitForTransactionReceipt({
      hash: await w.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, USDC(30), dep.inner, dep.encryptedNote], account: w.account!, chain: d.chain}),
    });
    if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
    await relay(await prepareBudgetInit({prover, admin: admin2, policy: open, agent: agent2.address, chainId: 31337n, pool: d.deployment.pool, timestamp: await now()}));

    const before = await erc20Balance(d, d.deployment.usdc, unverified);
    const b = (await agent2.preparePolicyPayment({amount: USDC(7), recipient: unverified})) as Extract<Bundle, {kind: "policyPay"}>;
    expect(b.inputs.vendorChecked).toBe(false);
    await relay(b);
    expect(await erc20Balance(d, d.deployment.usdc, unverified)).toBe(before + USDC(7));
    // caps still enforced in the circuit
    await expect(agent2.preparePolicyPayment({amount: USDC(11), recipient: unverified, unsafeSkipPolicyPrecheck: true})).rejects.toThrow(/over per-payment cap/);
    await relay(await agent2.preparePolicyPayment({amount: USDC(10), recipient: unverified}));
    await expect(agent2.preparePolicyPayment({amount: USDC(4), recipient: unverified, unsafeSkipPolicyPrecheck: true})).rejects.toThrow(/over budget/);
    // and it can't pretend to be "checked" without a real vendor proof
    const c = (await agent2.preparePolicyPayment({amount: USDC(1), recipient: unverified})) as Extract<Bundle, {kind: "policyPay"}>;
    await expect(simulateBundle(d.publicClient, d.deployment.pool, {...c, inputs: {...c.inputs, vendorChecked: true}}, d.address(RELAYER))).rejects.toThrow(/UnknownVendorRoot|InvalidProof|VendorNotActive/);
  });

  it("the human (admin) can sweep the agent's funds out with the admin key", async () => {
    const adminView = new AgentWallet({
      chainId: 31337n, pool: d.deployment.pool, prover, asp, keys: deriveAgentKeys(HUMAN_SEED, 0),
      sync: new PoolSync(d.publicClient, d.deployment.pool), policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree),
      admin: deriveAdminKeys(HUMAN_SEED),
    });
    await adminView.refresh();
    const bal = adminView.balance(d.deployment.usdc);
    const b = await adminView.preparePayment({token: d.deployment.usdc, amount: bal, recipient: d.address(HUMAN)});
    const before = await erc20Balance(d, d.deployment.usdc, d.address(HUMAN));
    await relay(b);
    expect(await erc20Balance(d, d.deployment.usdc, d.address(HUMAN))).toBe(before + bal);
  });
});
