/**
 * Live flows on Base Sepolia (TESTNET ONLY), after scripts/testnet.ts has set up the merchant,
 * the wallets and the agent's budget. Broadcasts from TESTNET_PRIVATE_KEY.
 *
 *   npx tsx scripts/testnet-flows.ts      # from zk/client
 *   ONLY=E,F npx tsx scripts/testnet-flows.ts   # just some flows
 *
 *   A. escrow released by the payer, submitted from an address that isn't the payer's
 *   B. escrow claimed by the merchant with a partial refund (and refused before claimableAt)
 *   C. escrow expired back to the payer (and the merchant refused after expiresAt)
 *   D. two payers in ONE batched transaction (plain payment + agent policy payment)
 *   E. x402 Path A: a `shielded` merchant paid refundably over HTTP, refunded by request id
 *   F. x402 Path B: an unmodified `exact` merchant, settled by its own stock facilitator against
 *      real Circle USDC through the pool's EIP-1271 signature
 *
 * Writes every transaction's L2 gas, L1 data gas and fees to
 * zk/benchmarks/results/base-sepolia-<date>.json. Uses ~1.5 USDC (most comes back) and
 * well under 0.001 ETH.
 */
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import express from "express";
import type {Server} from "node:http";
import type {Hex} from "viem";
import {x402Client} from "@x402/core/client";
import {x402ResourceServer} from "@x402/core/server";
import {x402Facilitator} from "@x402/core/facilitator";
import {paymentMiddleware} from "@x402/express";
import {decodePaymentResponseHeader, wrapFetchWithPayment} from "@x402/fetch";
import {ExactEvmScheme as ExactServer} from "@x402/evm/exact/server";
import {ExactEvmScheme as ExactFacilitator} from "@x402/evm/exact/facilitator";
import {toFacilitatorEvmSigner} from "@x402/evm";
import {baseSepolia} from "viem/chains";
import {PoolSync, type PaymentRecordView} from "../src/chain.js";
import {claimEscrow, expireEscrow, merchantRefund, submitEscrowRelease} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {type Bundle} from "../src/wallet.js";
import {mockUsdcAbi, shieldedPoolAbi} from "../src/abi.js";
import {localFacilitatorClient, PoolExactClientScheme, ShieldedClientScheme, ShieldedFacilitatorScheme, ShieldedServerScheme} from "../src/x402/index.js";
import {ZK_DIR} from "../src/devnet.js";
import {$, account, erc20, fromBlock, me, openWallets, pool, syncAssociationSet, publicClient, send, step, tx, U, usdc, wallet} from "./testnet-env.js";

const NET = "eip155:84532" as const;
const {prover, asp, human, agent} = await openWallets();
const relayer = new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee: {[usdc.toLowerCase()]: 0n}});
const book = (await publicClient.readContract({address: pool, abi: shieldedPoolAbi, functionName: "paymentBook"})) as `0x${string}`;

// ---- measurements -----------------------------------------------------------------------
type Row = {name: string; tx: Hex; block: number; l2GasUsed: number; l2GasPriceWei: number; l1GasUsed: number; l1FeeWei: number; totalFeeWei: number};
const rows: Row[] = [];
async function measure(name: string, hash: Hex): Promise<Hex> {
  // raw receipt: the OP-stack L1 fee fields as the node returns them
  const r = (await publicClient.request({method: "eth_getTransactionReceipt", params: [hash]} as never)) as Record<string, string>;
  const n = (k: string) => Number(BigInt(r[k] ?? "0x0"));
  const row = {name, tx: hash, block: n("blockNumber"), l2GasUsed: n("gasUsed"), l2GasPriceWei: n("effectiveGasPrice"), l1GasUsed: n("l1GasUsed"), l1FeeWei: n("l1Fee"), totalFeeWei: 0};
  row.totalFeeWei = row.l2GasUsed * row.l2GasPriceWei + row.l1FeeWei;
  rows.push(row);
  console.log(`  ${name}: ${tx(hash)}  (L2 gas ${row.l2GasUsed.toLocaleString()}, L1 gas ${row.l1GasUsed.toLocaleString()})`);
  return hash;
}
const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
};
async function expectRevert(what: string, f: () => Promise<unknown>, pattern: RegExp) {
  try {
    await f();
  } catch (e) {
    const msg = `${(e as Error).message}`;
    if (pattern.test(msg)) return console.log(`  ✓ refused: ${what}`);
    throw e;
  }
  throw new Error(`CHECK FAILED: ${what} was not refused`);
}
const chainNow = async () => (await publicClient.getBlock({blockTag: "latest"})).timestamp;
async function waitUntil(t: bigint) {
  const start = await chainNow();
  if (start >= t) return;
  console.log(`  waiting ${t - start}s of chain time…`);
  while ((await chainNow()) < t) await new Promise((ok) => setTimeout(ok, 2_000));
}
const relay = async (b: Bundle) => (await relayer.relay(b)).txHash;
async function payEscrow(amount: bigint, claimAfterSeconds: bigint, expireAfterSeconds: bigint): Promise<PaymentRecordView> {
  await human.refresh();
  const b = await human.preparePayment({token: usdc, amount, recipient: me, terms: {mode: "escrow", claimAfterSeconds, expireAfterSeconds}});
  await measure(`pay escrow ${$(amount)}`, await relay(b));
  await human.refresh();
  return human.opts.sync.payments.get((b as Extract<Bundle, {kind: "pay"}>).inputs.nullifiers[0])!;
}
const ONLY = process.env.ONLY?.split(",").map((x) => x.trim().toUpperCase());
const run = (flow: string) => !ONLY || ONLY.includes(flow);
const shielded = async () => (await human.refresh(), human.balance(usdc));

// ---- top-up --------------------------------------------------------------------------------
step("0. top up the shielded wallet");
if ((await shielded()) < U(2)) {
  const d = human.prepareDeposit(usdc, U(2));
  await send(usdc, mockUsdcAbi, "approve", [pool, U(2)]);
  await measure("deposit 2 USDC", await send(pool, shieldedPoolAbi, "deposit", [usdc, U(2), d.inner, d.encryptedNote]));
}
const aspTx = await syncAssociationSet(asp);
if (aspTx) await measure("association-set root", aspTx);
console.log(`  shielded ${$(await shielded())}, agent ${$(agent.balance(usdc))}`);

// ---- A ------------------------------------------------------------------------------------
if (run("A")) {
  step("A. escrow, released by the payer");
  const before = await erc20(usdc, me), sb = await shielded();
  const p = await payEscrow(U(0.3), 300n, 900n);
  check((await erc20(usdc, book)) >= U(0.3), "funds wait in the PaymentBook, not with the merchant");
  // the release secret is all that's needed; anyone can submit it (here: the operator address)
  await measure("release escrow", (await submitEscrowRelease(wallet, publicClient, pool, human.escrowRelease(p.id))).hash);
  check((await erc20(usdc, me)) === before + U(0.3), "merchant received 0.30");
  check((await shielded()) === sb - U(0.3), "payer's shielded balance −0.30");
}

// ---- B ------------------------------------------------------------------------------------
if (run("B")) {
  step("B. escrow, claimed by the merchant with a partial refund");
  const sb = await shielded();
  const p = await payEscrow(U(0.2), 30n, 900n);
  await expectRevert("merchant claim before claimableAt", () => claimEscrow(wallet, publicClient, pool, p, 0n), /EscrowNotClaimable|reverted/);
  await waitUntil(p.record.claimableAt);
  const before = await erc20(usdc, me);
  await measure("claim escrow, refund 0.05", (await claimEscrow(wallet, publicClient, pool, p, U(0.05))).hash);
  check((await erc20(usdc, me)) === before + U(0.15), "merchant received 0.15");
  check((await shielded()) === sb - U(0.15), "payer got 0.05 back as a private note (net −0.15)");
}

// ---- C ------------------------------------------------------------------------------------
if (run("C")) {
  step("C. escrow, expired back to the payer");
  const sb = await shielded();
  const p = await payEscrow(U(0.2), 20n, 45n);
  await waitUntil(p.record.expiresAt);
  await expectRevert("merchant claim after expiresAt", () => claimEscrow(wallet, publicClient, pool, p, 0n), /EscrowNotClaimable|reverted/);
  await measure("expire escrow", (await expireEscrow(wallet, publicClient, pool, p)).hash);
  check((await shielded()) === sb, "payer refunded in full, privately");
}

// ---- D ------------------------------------------------------------------------------------
if (run("D")) {
  step("D. two payers, one batched transaction");
  await agent.refresh();
  const batcher = new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee: {[usdc.toLowerCase()]: 0n}, batch: {maxSize: 2, windowMs: 60_000}});
  const before = await erc20(usdc, me);
  const [b1, b2] = await Promise.all([
    human.preparePayment({token: usdc, amount: U(0.1), recipient: me, terms: {mode: "refundable"}}),
    agent.preparePolicyPayment({amount: U(0.1), recipient: me}),
  ]);
  const res = await Promise.all([batcher.relay(b1), batcher.relay(b2)]);
  check(res[0]!.txHash === res[1]!.txHash && res[0]!.batchSize === 2, "both payments settled in one transaction");
  await measure("batch of 2 (refundable + policy)", res[0]!.txHash);
  check((await erc20(usdc, me)) === before + U(0.2), "merchant received 0.20");
}

// ---- E ------------------------------------------------------------------------------------
const servers: Server[] = [];
const listen = (app: express.Express) =>
  new Promise<string>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as {port: number}).port}`));
    servers.push(s);
  });

if (run("E")) {
  step("E. x402 Path A: shielded scheme, refundable, refunded by request id");
  const feeRelayer = new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee: {[usdc.toLowerCase()]: U(0.01)}});
  const relayerUrl = await listen(feeRelayer.app());
  const fac = new x402Facilitator().register(NET, new ShieldedFacilitatorScheme(feeRelayer, {network: NET, token: usdc, publicUrl: relayerUrl}));
  const rs = new x402ResourceServer(localFacilitatorClient(fac)).register(NET, new ShieldedServerScheme({usdc}));
  const app = express();
  app.use(paymentMiddleware({
    "GET /report": {
      accepts: {scheme: "shielded", network: NET, payTo: me, maxTimeoutSeconds: 300, price: {amount: U(0.2).toString(), asset: usdc, extra: {paymentModes: ["direct", "refundable"]}}},
      description: "testnet report",
    },
  } as never, rs));
  app.get("/report", (_q, res) => void res.json({report: "ok"}));
  const url = await listen(app);

  const sb = await shielded();
  const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, new ShieldedClientScheme({wallet: human, maxFee: U(0.02), terms: {mode: "refundable"}})));
  const res = await pay(`${url}/report`);
  check(res.status === 200 && (await res.json()).report === "ok", "HTTP 200 after paying 0.20 + 0.01 fee");
  const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
  await measure("x402 shielded payment", settle.transaction as Hex);
  // the merchant only knows the request id it served; it finds the payment by it
  const sync = new PoolSync(publicClient, pool, fromBlock);
  await sync.sync();
  await human.refresh();
  const mine = human.payments().find((p) => p.txHash.toLowerCase() === settle.transaction.toLowerCase())!;
  const byReq = [...sync.payments.values()].find((p) => p.requestId === mine.requestId)!;
  await measure("x402 refund by request id", (await merchantRefund(wallet, publicClient, pool, byReq, U(0.2))).hash);
  check((await shielded()) === sb - U(0.01), "refunded in full; only the facilitator fee is gone");
}

// ---- F ------------------------------------------------------------------------------------
if (run("F")) {
  step("F. x402 Path B: unmodified `exact` merchant, real Circle USDC, pool signs via EIP-1271");
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (a) => publicClient.readContract(a as never),
    verifyTypedData: (a) => publicClient.verifyTypedData(a as never),
    writeContract: (a) => wallet.writeContract({...(a as object), account, chain: baseSepolia} as never),
    sendTransaction: (a) => wallet.sendTransaction({...a, account, chain: baseSepolia}),
    waitForTransactionReceipt: (a) => publicClient.waitForTransactionReceipt(a),
    getCode: (a) => publicClient.getCode(a),
  });
  const facilitator = new x402Facilitator().register(NET, new ExactFacilitator(signer));
  const server = new x402ResourceServer(localFacilitatorClient(facilitator)).register(NET, new ExactServer());
  const app = express();
  app.use(paymentMiddleware({
    "GET /quote": {
      accepts: {scheme: "exact", network: NET, payTo: me, maxTimeoutSeconds: 300, price: {amount: U(0.2).toString(), asset: usdc, extra: {name: "USDC", version: "2"}}},
      description: "a stock x402 merchant",
    },
  } as never, server));
  app.get("/quote", (_q, res) => void res.json({quote: 42}));
  const url = await listen(app);

  const sb = await shielded(), before = await erc20(usdc, me);
  const scheme = new PoolExactClientScheme({
    wallet: human, fee: U(0.01), feeRecipient: me, publicClient,
    relay: async (b) => measure("pool.authorizeTransfer (proof)", await relay(b)),
  });
  const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, scheme));
  const res = await pay(`${url}/quote`);
  check(res.status === 200 && (await res.json()).quote === 42, "HTTP 200 from the stock merchant");
  const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
  await measure("USDC transferWithAuthorization (stock facilitator)", settle.transaction as Hex);
  // operator is merchant, fee recipient and facilitator here: +0.20 price +0.01 fee
  check((await erc20(usdc, me)) === before + U(0.21), "Circle USDC moved from the pool to the merchant");
  check((await shielded()) === sb - U(0.21), "payer's shielded balance −0.21");
}

for (const s of servers) s.close();
await prover.destroy();

const date = new Date().toISOString().slice(0, 10);
const out = join(ZK_DIR, "benchmarks", "results", `base-sepolia-${date}.json`);
// keep rows from earlier runs today (e.g. ONLY=E,F after a full run)
const prev: Row[] = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).rows : [];
const all = [...prev.filter((r) => !rows.some((x) => x.tx === r.tx)), ...rows];
writeFileSync(out, JSON.stringify({network: "base-sepolia", chainId: 84532, pool, date, note: "live receipts; L1 fees on Sepolia are not representative of mainnet, l1GasUsed is", rows: all}, null, 2) + "\n");
console.log(`\nAll flows passed. Receipts: ${out}`);
