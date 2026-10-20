/**
 * Recursive aggregation end to end (docs/aggregation.md), real proofs on a local anvil:
 * payers prove each payment for both targets, an aggregating relayer settles 2, 4 and 8 of
 * them with ONE aggregate proof (pool.settleAggregated), wallets see their notes, merchants
 * are paid, refunds still work, and every failure path falls back to pool.batch, logged.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {Address, Hex} from "viem";
import {approve, erc20Balance, mintUsdc, startDevnet, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {Aggregator} from "../src/aggregator.js";
import {ShieldedWallet, type Bundle} from "../src/wallet.js";
import {merchantRefund, submitBundle} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {shieldedPoolAbi} from "../src/abi.js";

const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const FEE = USDC(0.01);

let d: Devnet;
let prover: Prover;
let aggregator: Aggregator;
let asp: AspService;
const logs: string[] = [];

function wallet(n: number): ShieldedWallet {
  return new ShieldedWallet({
    keys: deriveSpendingKeys(new Uint8Array(32).fill(n)), sync: new PoolSync(d.publicClient, d.deployment.pool),
    chainId: 31337n, pool: d.deployment.pool, prover, asp, aggregatable: true,
  });
}

async function deposit(w: ShieldedWallet, amount: bigint) {
  const acct = 1;
  await mintUsdc(d, d.address(acct), amount);
  await approve(d, acct, d.deployment.usdc, d.deployment.pool, amount);
  const dep = w.prepareDeposit(d.deployment.usdc, amount);
  const wc = d.wallet(acct);
  await d.publicClient.waitForTransactionReceipt({
    hash: await wc.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, amount, dep.inner, dep.encryptedNote], account: wc.account!, chain: d.chain}),
  });
}

function relayer(opts: {maxSize?: number; aggregator?: Aggregator} = {}) {
  return new Relayer({
    pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(3), publicClient: d.publicClient,
    minFee: {[d.deployment.usdc.toLowerCase()]: FEE}, batch: {maxSize: opts.maxSize ?? 8, windowMs: 3_600_000},
    aggregation: {aggregator: opts.aggregator ?? aggregator, prover}, log: (m) => logs.push(m),
  });
}

/** flush once `n` bundles have passed intake (relay() checks asynchronously before queueing) */
async function flushWhenQueued(r: Relayer, n: number) {
  for (let i = 0; r.queued < n; i++) {
    if (i > 600) throw new Error(`only ${r.queued}/${n} bundles queued`);
    await new Promise((res) => setTimeout(res, 100));
  }
  await r.flush();
}

async function flushWhenQueuedAfter(r: Relayer, n: number, meanwhile: () => Promise<unknown>) {
  for (let i = 0; r.queued < n; i++) {
    if (i > 600) throw new Error(`only ${r.queued}/${n} bundles queued`);
    await new Promise((res) => setTimeout(res, 100));
  }
  await meanwhile();
  await r.flush();
}

const merchants: Address[] = [];
let payers: ShieldedWallet[] = [];
const feeTo = () => d.address(3);

async function pay(w: ShieldedWallet, i: number, amount: bigint, terms?: Parameters<ShieldedWallet["preparePayment"]>[0]["terms"]) {
  await w.refresh();
  return w.preparePayment({token: d.deployment.usdc, amount, recipient: merchants[i % merchants.length]!, fee: FEE, feeRecipient: feeTo(), terms});
}

beforeAll(async () => {
  d = await startDevnet(8620);
  prover = new Prover();
  aggregator = new Aggregator({backend: "native"});
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
  for (let i = 0; i < 3; i++) merchants.push(d.address(5 + i));
  payers = Array.from({length: 8}, (_, i) => wallet(40 + i));
  for (const w of payers) await deposit(w, USDC(50));
  if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
});

afterAll(async () => {
  await prover?.destroy();
  await aggregator?.destroy();
  d?.stop();
});

describe("settleAggregated with real proofs", () => {
  it("settles 2 payments with one aggregate proof; payers' wallets see their change", async () => {
    const r = relayer();
    const before = await Promise.all(merchants.map((m) => erc20Balance(d, d.deployment.usdc, m)));
    const bundles = [await pay(payers[0]!, 0, USDC(1)), await pay(payers[1]!, 1, USDC(2))];
    expect(bundles.every((b) => "recursiveProof" in b && b.recursiveProof)).toBe(true);
    const pending = bundles.map((b) => r.relay(b));
    await flushWhenQueued(r, pending.length);
    const res = await Promise.all(pending);
    console.log(`  settleAggregated N=2 gas: ${res[0]!.gasUsed}, aggregate proving ${(res[0]!.aggregateMs! / 1000).toFixed(1)} s`);
    expect(res.every((x) => x.mode === "aggregated" && x.batchSize === 2 && x.txHash === res[0]!.txHash)).toBe(true);
    expect(await erc20Balance(d, d.deployment.usdc, merchants[0]!)).toBe(before[0]! + USDC(1));
    expect(await erc20Balance(d, d.deployment.usdc, merchants[1]!)).toBe(before[1]! + USDC(2));
    await payers[0]!.refresh();
    await payers[1]!.refresh();
    expect(payers[0]!.balance(d.deployment.usdc)).toBe(USDC(50) - USDC(1) - FEE);
    expect(payers[1]!.balance(d.deployment.usdc)).toBe(USDC(50) - USDC(2) - FEE);
  });

  it("settles 4 mixed payments (direct, refundable, escrow) and the merchant can still refund", async () => {
    const r = relayer();
    const bundles = [
      await pay(payers[2]!, 0, USDC(1)),
      await pay(payers[3]!, 0, USDC(3), {mode: "refundable"}),
      await pay(payers[4]!, 1, USDC(2), {mode: "escrow", claimAfterSeconds: 3600n, expireAfterSeconds: 7200n}),
      await pay(payers[5]!, 2, USDC(1)),
    ];
    const pending = bundles.map((b) => r.relay(b));
    await flushWhenQueued(r, pending.length);
    const res = await Promise.all(pending);
    console.log(`  settleAggregated N=4 (mixed) gas: ${res[0]!.gasUsed}`);
    expect(res.every((x) => x.mode === "aggregated" && x.batchSize === 4)).toBe(true);
    // the refundable payment is a normal PaymentBook record: the merchant refunds 1 USDC privately
    await payers[3]!.refresh();
    const rec = payers[3]!.opts.sync.payments.get((bundles[1] as Extract<Bundle, {kind: "pay"}>).inputs.nullifiers[0])!;
    expect(rec).toBeDefined();
    await merchantRefund(d.wallet(5), d.publicClient, d.deployment.pool, rec, USDC(1));
    await payers[3]!.refresh();
    expect(payers[3]!.balance(d.deployment.usdc)).toBe(USDC(50) - USDC(3) - FEE + USDC(1));
    // the escrow waits in the book
    await payers[4]!.refresh();
    expect(payers[4]!.payments().length).toBe(1);
  });

  it("settles 8 payments with one aggregate proof", async () => {
    const r = relayer();
    const bundles: Bundle[] = [];
    for (let i = 0; i < 8; i++) bundles.push(await pay(payers[i]!, i, USDC(0.5)));
    const pending = bundles.map((b) => r.relay(b)); // the 8th fills the queue and flushes
    const res = await Promise.all(pending);
    console.log(`  settleAggregated N=8 gas: ${res[0]!.gasUsed}, aggregate proving ${(res[0]!.aggregateMs! / 1000).toFixed(1)} s`);
    expect(res.every((x) => x.mode === "aggregated" && x.batchSize === 8)).toBe(true);
  });
});

describe("relayer intake and fallbacks", () => {
  it("refuses a second bundle spending a nullifier already in its queue", async () => {
    const r = relayer();
    const b = await pay(payers[6]!, 0, USDC(1));
    const p = r.relay(b);
    await expect(r.relay({...b, ext: {...b.ext}})).rejects.toThrow(/already queued/);
    await flushWhenQueued(r, 1);
    const res = await p;
    // a lone aggregatable bundle has no aggregate size: settled by pool.batch, and says why
    expect(res.mode).toBe("batch");
    expect(res.fallback).toMatch(/no aggregate size/);
  });

  it("refuses a bundle whose recursion proof does not match its statement", async () => {
    const r = relayer();
    const b = (await pay(payers[7]!, 0, USDC(1))) as Extract<Bundle, {kind: "transact"}>;
    const bad = (b.recursiveProof!.slice(0, 200) + (b.recursiveProof![200] === "0" ? "1" : "0") + b.recursiveProof!.slice(201)) as Hex;
    await expect(r.relay({...b, recursiveProof: bad})).rejects.toThrow(/recursiveProof does not verify/);
    // and one made for a different statement (another payment's) is refused too
    const other = (await pay(payers[6]!, 1, USDC(2))) as Extract<Bundle, {kind: "transact"}>;
    await expect(r.relay({...b, recursiveProof: other.recursiveProof})).rejects.toThrow(/recursiveProof does not verify/);
  });

  it("if the aggregator fails, the group settles through pool.batch and the fallback is logged", async () => {
    const broken = {backend: "native", aggregate: async () => Promise.reject(new Error("prover crashed")), destroy: async () => {}} as unknown as Aggregator;
    const r = relayer({aggregator: broken});
    logs.length = 0;
    const bundles = [await pay(payers[0]!, 0, USDC(1)), await pay(payers[1]!, 1, USDC(1))];
    const pending = bundles.map((b) => r.relay(b));
    await flushWhenQueued(r, pending.length);
    const res = await Promise.all(pending);
    expect(res.every((x) => x.mode === "batch" && x.batchSize === 2 && /prover crashed/.test(x.fallback ?? ""))).toBe(true);
    expect(logs.some((l) => /aggregation of 2 failed while proving: prover crashed; falling back to pool.batch/.test(l))).toBe(true);
  });

  it("a payment double-spent while queued is dropped before proving; the other still settles", async () => {
    const r = relayer();
    logs.length = 0;
    const a = await pay(payers[2]!, 0, USDC(1));
    const b = await pay(payers[3]!, 1, USDC(1));
    const pa = r.relay(a);
    pa.catch(() => {}); // asserted below; don't report it as unhandled meanwhile
    const pb = r.relay(b);
    // meanwhile `a`'s payer settles the same proof itself (the escape hatch)
    await flushWhenQueuedAfter(r, 2, () => submitBundle(d.wallet(4), d.publicClient, d.deployment.pool, a));
    await expect(pa).rejects.toThrow(/NullifierSpent/);
    const rb = await pb;
    expect(rb.mode).toBe("batch");
    expect(rb.fallback).toMatch(/no aggregate size/);
    expect(logs.some((l) => /dropped a queued bundle/.test(l))).toBe(true);
  });

  it("a payment double-spent DURING proving fails alone at simulation; the others settle", async () => {
    const a = await pay(payers[4]!, 0, USDC(1));
    const b = await pay(payers[5]!, 1, USDC(1));
    // an aggregator that, while it proves, lets `a`'s payer settle `a` directly
    const racing = {
      backend: "native",
      aggregate: async (inner: Parameters<Aggregator["aggregate"]>[0]) => {
        await submitBundle(d.wallet(4), d.publicClient, d.deployment.pool, a);
        return aggregator.aggregate(inner);
      },
    } as unknown as Aggregator;
    const r = relayer({aggregator: racing});
    logs.length = 0;
    const pa = r.relay(a);
    pa.catch(() => {}); // asserted below; don't report it as unhandled meanwhile
    const pb = r.relay(b);
    await flushWhenQueued(r, 2);
    await expect(pa).rejects.toThrow();
    const rb = await pb;
    expect(rb.mode).toBe("single");
    expect(rb.fallback).toMatch(/aggregation of 2 failed while simulating/);
    expect(logs.some((l) => /falling back to pool.batch/.test(l))).toBe(true);
    expect(logs.some((l) => /pool.batch of 2 failed/.test(l))).toBe(true);
  });
});
