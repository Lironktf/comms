/**
 * M6 end to end: private swaps (deposit USDC, later hold/pay WETH) and batched payments
 * (several payments to different merchants in ONE transaction).
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeAbiParameters, type Address} from "viem";
import {approve, erc20Balance, mintUsdc, startDevnet, type Devnet} from "../src/devnet.js";
import {AspService, blocklistRule} from "../src/asp.js";
import {PoolSync} from "../src/chain.js";
import {deriveSpendingKeys} from "../src/keys.js";
import {Prover} from "../src/prover.js";
import {ShieldedWallet, type Bundle} from "../src/wallet.js";
import {simulateBundle, submitBundle} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {shieldedPoolAbi} from "../src/abi.js";

const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const WETH = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const FEE3000 = encodeAbiParameters([{type: "uint24"}], [3000]);

let d: Devnet;
let prover: Prover;
let asp: AspService;

function wallet(n: number): ShieldedWallet {
  return new ShieldedWallet({keys: deriveSpendingKeys(new Uint8Array(32).fill(n)), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
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

beforeAll(async () => {
  d = await startDevnet(8614);
  prover = new Prover();
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
});

afterAll(async () => {
  await prover?.destroy();
  d?.stop();
});

describe("private swaps through the Uniswap V3 adapter", () => {
  let alice: ShieldedWallet;
  let swapBundle: Extract<Bundle, {kind: "swap"}>;

  beforeAll(async () => {
    alice = wallet(21);
    await deposit(alice, USDC(100));
    if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
  });

  it("rejects tampered swap parameters (slippage bound is in the proof)", async () => {
    swapBundle = (await alice.prepareSwap({
      token: d.deployment.usdc, amountIn: USDC(40),
      swap: {adapter: d.deployment.swapAdapter, tokenOut: d.deployment.weth, minAmountOut: WETH(0.0159), data: FEE3000},
    })) as Extract<Bundle, {kind: "swap"}>;
    const tampered = {...swapBundle, swap: {...swapBundle.swap, minAmountOut: 1n}};
    await expect(simulateBundle(d.publicClient, d.deployment.pool, tampered)).rejects.toThrow(/InvalidProof/);
  });

  it("swaps 40 USDC -> WETH and re-shields the output as a note for the same owner", async () => {
    const {gasUsed} = await submitBundle(d.wallet(2), d.publicClient, d.deployment.pool, swapBundle);
    console.log(`  swap gas: ${gasUsed}`);
    await alice.refresh();
    expect(alice.balance(d.deployment.usdc)).toBe(USDC(60));
    // mock router: 1 USDC = 0.0004 WETH
    expect(alice.balance(d.deployment.weth)).toBe(WETH(0.016));
  });

  it("enforces minAmountOut against what the pool actually receives", async () => {
    const b = await alice.prepareSwap({
      token: d.deployment.usdc, amountIn: USDC(10),
      swap: {adapter: d.deployment.swapAdapter, tokenOut: d.deployment.weth, minAmountOut: WETH(0.0041), data: FEE3000},
    });
    await expect(simulateBundle(d.publicClient, d.deployment.pool, b)).rejects.toThrow(/Too little received|SlippageExceeded/);
  });

  it("the swapped WETH note is spendable: pay a merchant in WETH", async () => {
    const m = d.address(8);
    const b = await alice.preparePayment({token: d.deployment.weth, amount: WETH(0.01), recipient: m});
    await submitBundle(d.wallet(2), d.publicClient, d.deployment.pool, b);
    expect(await erc20Balance(d, d.deployment.weth, m)).toBe(WETH(0.01));
    await alice.refresh();
    expect(alice.balance(d.deployment.weth)).toBe(WETH(0.006));
  });
});

describe("batching: many payments, different merchants, one transaction", () => {
  it("a batching relayer settles 4 payments in 1 tx and it costs less per payment", async () => {
    const payers = [31, 32, 33, 34].map(wallet);
    for (const w of payers) await deposit(w, USDC(10));
    if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
    const merchants: Address[] = [d.address(5), d.address(6), d.address(7), d.address(9)];

    const relayer = new Relayer({
      pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(2), publicClient: d.publicClient,
      minFee: {[d.deployment.usdc.toLowerCase()]: USDC(0.01)}, batch: {maxSize: 4, windowMs: 60_000},
    });
    const bundles: Bundle[] = [];
    for (let i = 0; i < 4; i++) {
      bundles.push(await payers[i]!.preparePayment({token: d.deployment.usdc, amount: USDC(1 + i), recipient: merchants[i]!, fee: USDC(0.01), feeRecipient: relayer.address}));
    }
    const before = await Promise.all(merchants.map((m) => erc20Balance(d, d.deployment.usdc, m)));
    const results = await Promise.all(bundles.map((b) => relayer.relay(b)));
    expect(new Set(results.map((r) => r.txHash)).size).toBe(1);
    expect(results[0]!.batchSize).toBe(4);
    for (let i = 0; i < 4; i++) expect(await erc20Balance(d, d.deployment.usdc, merchants[i]!)).toBe(before[i]! + USDC(1 + i));

    const single = await submitBundle(d.wallet(2), d.publicClient, d.deployment.pool,
      await payers[0]!.preparePayment({token: d.deployment.usdc, amount: USDC(0.5), recipient: merchants[0]!}));
    const perPayment = results[0]!.gasUsed / 4n;
    console.log(`  batch of 4: ${results[0]!.gasUsed} gas total, ${perPayment} per payment; single: ${single.gasUsed}`);
    expect(perPayment < single.gasUsed).toBe(true);
    for (const w of payers) await w.refresh();
    expect(payers[3]!.balance(d.deployment.usdc)).toBe(USDC(10) - USDC(4) - USDC(0.01));
  });
});
