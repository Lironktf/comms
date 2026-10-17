/**
 * Refunds, escrow and mixed batching, end to end with REAL proofs on anvil.
 *
 *   refundable  merchant paid at once; refunds (partial/full) come back as private notes the
 *               payer finds, spends and can ragequit (same deposit lineage)
 *   escrow      release by the payer (submitted from a stranger's address), merchant claim
 *               after the window (with a partial refund), dispute + arbiter split, expiry
 *   agents      refunds land in POLICY-bound notes; a suspended vendor can't collect an escrow
 *   batch       transact + refundable pay + policy pay from different payers in ONE tx
 *   x402        a merchant accepting "refundable" payments refunds a request by its id
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import express from "express";
import type {Server} from "node:http";
import type {Address} from "viem";
import {x402Client} from "@x402/core/client";
import {x402ResourceServer} from "@x402/core/server";
import {x402Facilitator} from "@x402/core/facilitator";
import {paymentMiddleware} from "@x402/express";
import {wrapFetchWithPayment} from "@x402/fetch";
import {approve, erc20Balance, increaseTime, mintUsdc, registerVerifiedVendor, startDevnet, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync, type PaymentRecordView} from "../src/chain.js";
import {deriveAdminKeys, deriveAgentKeys, deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {AgentWallet, prepareBudgetInit, ShieldedWallet, type Bundle} from "../src/wallet.js";
import {VendorTreeSync} from "../src/vendors.js";
import {policyHash, type PolicyParams} from "../src/hashes.js";
import {
  claimEscrow, expireEscrow, merchantRefund, resolveEscrow, simulateBundle, submitBundle, submitEscrowDispute,
  submitEscrowRelease, submitRagequit,
} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {shieldedPoolAbi, vendorRegistryAbi} from "../src/abi.js";
import {localFacilitatorClient, ShieldedClientScheme, ShieldedFacilitatorScheme, ShieldedServerScheme} from "../src/x402/index.js";

const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const SEED_A = new Uint8Array(32).fill(21);
const SEED_B = new Uint8Array(32).fill(22);
const HUMAN = 1, RELAYER = 2, STRANGER = 3, MERCH = 4, ARBITER = 7, HUMAN_B = 8, X402_MERCH = 5;
const NET = "eip155:31337" as const;
const PAYEE = "0x000000000000000000000000000000000000dEaD" as Address; // any public payee

let d: Devnet;
let prover: Prover;
let asp: AspService;
let alice: ShieldedWallet;
let bob: ShieldedWallet;
let agent: AgentWallet;
let policy: PolicyParams;
let merch: Address;
const gas: Record<string, bigint> = {};

const relay = (b: Bundle) => submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool, b);
const usdc = () => d.deployment.usdc;
const bal = (w: ShieldedWallet) => w.balance(usdc());

async function depositFor(w: ShieldedWallet, from: number, amount: bigint, opts: {to?: ShieldedWallet["address"]; policy?: bigint} = {}) {
  await mintUsdc(d, d.address(from), amount);
  await approve(d, from, usdc(), d.deployment.pool, amount);
  const dep = w.prepareDeposit(usdc(), amount, opts);
  const wc = d.wallet(from);
  await d.publicClient.waitForTransactionReceipt({
    hash: await wc.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [usdc(), amount, dep.inner, dep.encryptedNote], account: wc.account!, chain: d.chain}),
  });
  if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
}

/** The payment this bundle created, as the merchant/arbiter would find it onchain. */
async function recordOf(w: ShieldedWallet, b: Bundle): Promise<PaymentRecordView> {
  await w.refresh();
  const id = b.kind === "pay" || b.kind === "policyPay" ? b.inputs.nullifiers[0] : -1n;
  const r = w.opts.sync.payments.get(id);
  if (!r) throw new Error("payment not recorded");
  return r;
}

beforeAll(async () => {
  d = await startDevnet(8640);
  prover = new Prover();
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
  merch = d.address(MERCH);
  await registerVerifiedVendor(d, {owner: MERCH, domain: "api.shop.example", wallet: merch, level: 3, categories: 0b010n});
  const base = {chainId: 31337n, pool: d.deployment.pool, prover, asp};
  alice = new ShieldedWallet({...base, keys: deriveSpendingKeys(SEED_A), sync: new PoolSync(d.publicClient, d.deployment.pool)});
  bob = new ShieldedWallet({...base, keys: deriveSpendingKeys(SEED_B), sync: new PoolSync(d.publicClient, d.deployment.pool)});
  const admin = deriveAdminKeys(SEED_A);
  policy = {
    adminPk: admin.adminPk, token: BigInt(usdc()), maxPerPayment: USDC(10), maxFee: USDC(0.05),
    periodBudget: USDC(50), periodSeconds: 30n * 86400n, minVendorLevel: 2n, categoryMask: 0n, requireVerifiedVendor: true,
  };
  agent = new AgentWallet({
    ...base, keys: deriveAgentKeys(SEED_A, 0), sync: new PoolSync(d.publicClient, d.deployment.pool),
    policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree),
  });
  await depositFor(alice, HUMAN, USDC(100));
  await depositFor(bob, HUMAN_B, USDC(20));
  await depositFor(alice, HUMAN, USDC(40), {to: agent.address, policy: policyHash(policy)});
  await relay(await prepareBudgetInit({prover, admin, policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: (await d.publicClient.getBlock()).timestamp}));
  await alice.refresh();
  await agent.refresh();
});

afterAll(async () => {
  await prover?.destroy();
  d?.stop();
  console.log("refund/escrow gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, v.toString()])));
});

describe("refundable payments (real proofs)", () => {
  let rec: PaymentRecordView;

  it("merchant is paid at once; the payment is recorded with a refund slot only the payer recognises", async () => {
    const b = await alice.preparePayment({token: usdc(), amount: USDC(10), recipient: merch, terms: {mode: "refundable"}});
    expect(b.kind).toBe("pay");
    gas.payRefundable = (await relay(b)).gasUsed;
    expect(await erc20Balance(d, usdc(), merch)).toBe(USDC(10));
    rec = await recordOf(alice, b);
    expect(rec.record.mode).toBe(1);
    expect(rec.record.amount).toBe(USDC(10));
    expect(alice.payments().map((p) => p.id)).toContain(rec.id);
    await bob.refresh();
    expect(bob.payments().map((p) => p.id)).not.toContain(rec.id); // nobody else can tell it's alice's
    expect(bal(alice)).toBe(USDC(90));
  });

  it("partial then full refund come back as private notes alice can find", async () => {
    gas.refund = (await merchantRefund(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec, USDC(4))).gasUsed;
    await alice.refresh();
    expect(bal(alice)).toBe(USDC(94));
    await expect(merchantRefund(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec, USDC(7))).rejects.toThrow();
    await merchantRefund(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec, USDC(6));
    await alice.refresh();
    expect(bal(alice)).toBe(USDC(100));
    expect(alice.opts.sync.payments.get(rec.id)!.status).toBe("closed");
    expect(await erc20Balance(d, usdc(), merch)).toBe(0n);
  });

  it("a refund note keeps the deposit lineage: it can be spent, and ragequits to the depositor", async () => {
    const refunds = alice.unspent().filter((n) => n.note.kind === "note" && (n.note.amount === USDC(4) || n.note.amount === USDC(6)));
    expect(refunds.length).toBe(2);
    const before = await erc20Balance(d, usdc(), d.address(HUMAN));
    await submitRagequit(d.wallet(STRANGER), d.publicClient, d.deployment.pool, await alice.prepareRagequit(refunds[0]!));
    expect(await erc20Balance(d, usdc(), d.address(HUMAN))).toBe(before + (refunds[0]!.note as {amount: bigint}).amount);
    // and a normal private payment can spend the other refund note (real transact proof)
    await alice.refresh();
    await relay(await alice.preparePayment({token: usdc(), amount: USDC(6), recipient: d.address(9)}));
    expect(await erc20Balance(d, usdc(), d.address(9))).toBe(USDC(6));
  });
});

describe("escrow (real proofs)", () => {
  const terms = {mode: "escrow" as const, claimAfterSeconds: 3600n, expireAfterSeconds: 86400n};

  it("funds wait in the PaymentBook; alice releases early, submitted by a stranger", async () => {
    await alice.refresh();
    const before = bal(alice);
    const b = await alice.preparePayment({token: usdc(), amount: USDC(5), recipient: merch, terms});
    gas.payEscrow = (await relay(b)).gasUsed;
    const merchBefore = await erc20Balance(d, usdc(), merch);
    const book = d.deployment.paymentBook;
    expect(await erc20Balance(d, usdc(), book)).toBe(USDC(5));
    const rec = await recordOf(alice, b);
    await expect(claimEscrow(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec)).rejects.toThrow(); // too early
    gas.release = (await submitEscrowRelease(d.wallet(STRANGER), d.publicClient, d.deployment.pool, alice.escrowRelease(rec.id))).gasUsed;
    expect(await erc20Balance(d, usdc(), merch)).toBe(merchBefore + USDC(5));
    expect(await erc20Balance(d, usdc(), book)).toBe(0n);
    await alice.refresh();
    expect(bal(alice)).toBe(before - USDC(5));
  });

  it("merchant claims after the window, refunding part", async () => {
    const before = bal(alice);
    const b = await alice.preparePayment({token: usdc(), amount: USDC(4), recipient: merch, terms});
    await relay(b);
    const rec = await recordOf(alice, b);
    const merchBefore = await erc20Balance(d, usdc(), merch);
    await increaseTime(d, 3601);
    gas.claimWithRefund = (await claimEscrow(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec, USDC(1))).gasUsed;
    expect(await erc20Balance(d, usdc(), merch)).toBe(merchBefore + USDC(3));
    await alice.refresh();
    expect(bal(alice)).toBe(before - USDC(4) + USDC(1));
  });

  it("dispute before the window, the arbiter splits", async () => {
    const before = bal(alice);
    const b = await alice.preparePayment({token: usdc(), amount: USDC(8), recipient: merch, terms: {...terms, arbiter: d.address(ARBITER)}});
    await relay(b);
    const rec = await recordOf(alice, b);
    await submitEscrowDispute(d.wallet(STRANGER), d.publicClient, d.deployment.pool, alice.escrowDispute(rec.id));
    await alice.refresh();
    expect(alice.opts.sync.payments.get(rec.id)!.status).toBe("disputed");
    await increaseTime(d, 3601);
    await expect(claimEscrow(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec)).rejects.toThrow(); // disputed
    const merchBefore = await erc20Balance(d, usdc(), merch);
    await resolveEscrow(d.wallet(ARBITER), d.publicClient, d.deployment.pool, rec, USDC(2));
    expect(await erc20Balance(d, usdc(), merch)).toBe(merchBefore + USDC(2));
    await alice.refresh();
    expect(bal(alice)).toBe(before - USDC(8) + USDC(6));
  });

  it("the release secret can't be replayed as a dispute; a wrong wallet can't act at all", async () => {
    const b = await alice.preparePayment({token: usdc(), amount: USDC(1), recipient: merch, terms: {...terms, arbiter: d.address(ARBITER)}});
    await relay(b);
    const rec = await recordOf(alice, b);
    const rel = alice.escrowRelease(rec.id);
    await expect(submitEscrowDispute(d.wallet(STRANGER), d.publicClient, d.deployment.pool, {...rel})).rejects.toThrow();
    await bob.refresh();
    expect(() => bob.escrowRelease(rec.id)).toThrow(/not ours/);
    await submitEscrowRelease(d.wallet(STRANGER), d.publicClient, d.deployment.pool, rel);
  });

  it("an unclaimed escrow returns to alice after expiry (anyone can trigger it)", async () => {
    const before = bal(alice);
    const b = await alice.preparePayment({token: usdc(), amount: USDC(3), recipient: merch, terms});
    await relay(b);
    const rec = await recordOf(alice, b);
    await expect(expireEscrow(d.wallet(STRANGER), d.publicClient, d.deployment.pool, rec)).rejects.toThrow();
    await increaseTime(d, 86401);
    gas.expire = (await expireEscrow(d.wallet(STRANGER), d.publicClient, d.deployment.pool, rec)).gasUsed;
    await alice.refresh();
    expect(bal(alice)).toBe(before);
  });
});

describe("agent payments with refunds and escrow (policy_pay, real proofs)", () => {
  it("a refund to an agent lands in a POLICY-bound note", async () => {
    await publishVendor();
    const before = agent.balance(usdc());
    const b = await agent.preparePolicyPayment({amount: USDC(2), recipient: merch, terms: {mode: "refundable"}});
    gas.policyPayRefundable = (await relay(b)).gasUsed;
    const rec = await recordOf(agent, b);
    expect(rec.record.vendorChecked).toBe(true);
    await merchantRefund(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec, USDC(2));
    await agent.refresh();
    expect(agent.balance(usdc())).toBe(before);
    const refundNote = agent.unspent().find((n) => n.note.kind === "note" && n.note.amount === USDC(2));
    expect(refundNote && refundNote.note.kind === "note" && refundNote.note.policy).toBe(agent.policyId);
    // budget is NOT restored by a refund (conservative: the budget counts spending attempts)
    expect(agent.budgetNote()!.note.kind === "budget" && agent.budgetNote()!.note.remaining).toBe(USDC(48));
  });

  it("a merchant suspended in Grayr can't collect an agent's escrow; it expires back to the agent", async () => {
    const before = agent.balance(usdc());
    const b = await agent.preparePolicyPayment({amount: USDC(3), recipient: merch, terms: {mode: "escrow", claimAfterSeconds: 600n, expireAfterSeconds: 7200n}});
    await relay(b);
    const rec = await recordOf(agent, b);
    const vendorId = await d.publicClient.readContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "vendorIdForWallet", args: [merch]});
    const g = d.wallet(0);
    await d.publicClient.waitForTransactionReceipt({
      hash: await g.writeContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "suspendVendor", args: [vendorId, "incident"], account: g.account!, chain: d.chain}),
    });
    await increaseTime(d, 601);
    await expect(claimEscrow(d.wallet(MERCH), d.publicClient, d.deployment.pool, rec)).rejects.toThrow(/VendorNotActive|reverted/);
    await increaseTime(d, 7200);
    await expireEscrow(d.wallet(STRANGER), d.publicClient, d.deployment.pool, rec);
    await agent.refresh();
    expect(agent.balance(usdc())).toBe(before);
    // reinstate for later tests
    await d.publicClient.waitForTransactionReceipt({
      hash: await g.writeContract({address: d.deployment.vendorRegistry, abi: vendorRegistryAbi, functionName: "unsuspendVendor", args: [vendorId, "resolved"], account: g.account!, chain: d.chain}),
    });
  });
});

async function publishVendor() {
  const {publishVendor: pv} = await import("../src/devnet.js");
  await pv(d, merch);
}

describe("mixed batch through a batching relayer", () => {
  it("transact + refundable pay + policy pay from three payers settle in ONE transaction", async () => {
    await publishVendor();
    const r = new Relayer({
      pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(RELAYER), publicClient: d.publicClient,
      minFee: {[usdc().toLowerCase()]: 0n}, batch: {maxSize: 3, windowMs: 30_000},
    });
    const [b1, b2, b3] = await Promise.all([
      alice.preparePayment({token: usdc(), amount: USDC(1), recipient: PAYEE}),
      bob.preparePayment({token: usdc(), amount: USDC(2), recipient: merch, terms: {mode: "refundable"}}),
      agent.preparePolicyPayment({amount: USDC(1.5), recipient: merch}),
    ]);
    for (const b of [b1, b2, b3]) await simulateBundle(d.publicClient, d.deployment.pool, b, r.address);
    const merchBefore = await erc20Balance(d, usdc(), merch);
    const results = await Promise.all([r.relay(b1), r.relay(b2), r.relay(b3)]);
    expect(new Set(results.map((x) => x.txHash)).size).toBe(1);
    expect(results[0]!.batchSize).toBe(3);
    gas.batchOf3Mixed = results[0]!.gasUsed;
    expect(await erc20Balance(d, usdc(), merch)).toBe(merchBefore + USDC(3.5));
    expect(await erc20Balance(d, usdc(), PAYEE)).toBe(USDC(1));
    await bob.refresh();
    expect(bob.payments().length).toBe(1);
  });
});

describe("x402 with refundable payments", () => {
  let server: Server;
  let relayerServer: Server;
  let url: string;
  let relayer: Relayer;

  beforeAll(async () => {
    relayer = new Relayer({pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(RELAYER), publicClient: d.publicClient, minFee: {[usdc().toLowerCase()]: USDC(0.01)}});
    // proofs are too big for a header: the facilitator's relayer stores bundles by content id
    const relayerUrl = await new Promise<string>((ok) => {
      relayerServer = relayer.app().listen(0, () => ok(`http://127.0.0.1:${(relayerServer.address() as {port: number}).port}`));
    });
    const fac = new x402Facilitator().register(NET, new ShieldedFacilitatorScheme(relayer, {network: NET, token: usdc(), publicUrl: relayerUrl}));
    const rs = new x402ResourceServer(localFacilitatorClient(fac)).register(NET, new ShieldedServerScheme({usdc: usdc()}));
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /report": {
            accepts: {scheme: "shielded", network: NET, payTo: d.address(X402_MERCH), maxTimeoutSeconds: 300, price: {amount: USDC(0.5).toString(), asset: usdc(), extra: {paymentModes: ["direct", "refundable"]}}},
            description: "report",
          },
        } as never,
        rs,
      ),
    );
    app.get("/report", (_q, res) => void res.json({ok: true}));
    await new Promise<void>((ok) => {
      server = app.listen(0, () => ok());
    });
    url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });
  afterAll(() => {
    server?.close();
    relayerServer?.close();
  });

  it("agent pays refundably; the merchant refunds that x402 request by its id", async () => {
    await bob.refresh();
    const before = bal(bob);
    const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, new ShieldedClientScheme({wallet: bob, maxFee: USDC(0.02), terms: {mode: "refundable"}})));
    const res = await pay(`${url}/report`);
    expect(res.status).toBe(200);
    await bob.refresh();
    const mine = bob.payments().filter((p) => p.record.merchant.toLowerCase() === d.address(X402_MERCH).toLowerCase());
    expect(mine.length).toBe(1);
    // the merchant only knows the request id it served; it finds the payment by it
    const sync = new PoolSync(d.publicClient, d.deployment.pool);
    await sync.sync();
    const byReq = [...sync.payments.values()].find((p) => p.requestId === mine[0]!.requestId)!;
    await merchantRefund(d.wallet(X402_MERCH), d.publicClient, d.deployment.pool, byReq, USDC(0.5));
    await bob.refresh();
    expect(bal(bob)).toBe(before - USDC(0.01)); // only the facilitator fee is gone
  });

  it("an agent asking for escrow is refused up front when the merchant doesn't offer it", async () => {
    const pay = wrapFetchWithPayment(
      fetch,
      new x402Client().register(NET, new ShieldedClientScheme({wallet: bob, maxFee: USDC(0.02), terms: {mode: "escrow", claimAfterSeconds: 60n, expireAfterSeconds: 3600n}})),
    );
    await expect(pay(`${url}/report`)).rejects.toThrow(/does not accept escrow/);
  });
});
