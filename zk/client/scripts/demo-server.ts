/**
 * Public live demo on Base Sepolia (TESTNET ONLY): a visitor presses a button, and an AI agent
 * privately pays a real x402 API. Every step streams to the page as it happens, with Basescan
 * links.
 *
 *   TESTNET_PRIVATE_KEY=$(cat ~/.config/grayr-zk/operator-testnet.key) npx tsx scripts/demo-server.ts
 *   # serves http://127.0.0.1:8787 ; publish it with e.g. `cloudflared tunnel --url http://127.0.0.1:8787`
 *
 * One process plays every role, on the operator key:
 *   - merchant: `GET /api/weather`, an x402 API (scheme `shielded`) that is a Grayr-verified vendor
 *   - facilitator + relayer: verifies the proof, submits it, pays the gas (fee 0 for the demo)
 *   - the payer: the testnet wallets from scripts/testnet.ts. Their keys live on this server,
 *     so a visitor drives the demo agent; the proof is built here, not in the visitor's browser.
 * Every payment is REFUNDABLE and the merchant refunds it right after, so the demo wallets keep
 * their balance and a run costs only gas (~0.000013 ETH).
 *
 * Public routes: the page, /demo/*, /api/weather (a real 402 for anyone to curl) and the bundle
 * upload. The relayer's own /v1/relay is NOT exposed: with fee 0 it would let anyone spend the
 * operator's gas. Limits: one run at a time, DEMO_MAX_PER_DAY runs, one per IP every 20 s, and
 * runs stop below DEMO_MIN_ETH.
 */
import express from "express";
import {join} from "node:path";
import {decodeEventLog, parseAbiItem, type Address, type Hex} from "viem";
import {x402Client} from "@x402/core/client";
import {x402ResourceServer} from "@x402/core/server";
import {x402Facilitator} from "@x402/core/facilitator";
import {paymentMiddleware} from "@x402/express";
import {decodePaymentResponseHeader, wrapFetchWithPayment} from "@x402/fetch";
import type {FacilitatorClient} from "@x402/core/server";
import {PoolSync} from "../src/chain.js";
import {merchantRefund} from "../src/pool.js";
import {Relayer} from "../src/relayer.js";
import {toWire} from "../src/serde.js";
import {vendorRegistryAbi, vendorTreeAbi} from "../src/abi.js";
import {localFacilitatorClient, ShieldedClientScheme, ShieldedFacilitatorScheme, ShieldedServerScheme} from "../src/x402/index.js";
import {ZK_DIR} from "../src/devnet.js";
import {$, DOMAIN, dep, fromBlock, me, openWallets, pool, publicClient, read, send, syncAssociationSet, U, usdc, wallet} from "./testnet-env.js";

const PORT = Number(process.env.DEMO_PORT ?? 8787);
const PUBLIC_URL = process.env.DEMO_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const MAX_PER_DAY = Number(process.env.DEMO_MAX_PER_DAY ?? 150);
/** ASSUMPTION: ~40 runs of headroom at ~0.000013 ETH per run (live receipts 2026-10-17). */
const MIN_ETH = BigInt(Math.round(Number(process.env.DEMO_MIN_ETH ?? 0.0005) * 1e18));
const PRICE = U(0.1);
const NET = "eip155:84532" as const;
const LOCAL = `http://127.0.0.1:${PORT}`;

const {prover, asp, human, agent, vendors, policy} = await openWallets();
const relayer = new Relayer({pool, chainId: 84532n, wallet, publicClient, minFee: {[usdc.toLowerCase()]: 0n}});

// ---- the merchant's x402 API, with an instrumented facilitator --------------------------
type Emit = (e: Record<string, unknown>) => void;
let emit: Emit = () => {};
const inner = localFacilitatorClient(
  new x402Facilitator().register(NET, new ShieldedFacilitatorScheme(relayer, {network: NET, token: usdc, publicUrl: `${PUBLIC_URL}/relayer`})),
);
const facilitator: FacilitatorClient = {
  getSupported: inner.getSupported,
  async verify(p, r) {
    const t = Date.now();
    const v = await inner.verify(p, r);
    emit({step: "verify", ok: v.isValid, ms: Date.now() - t, detail: v.isValid ? undefined : v.invalidMessage});
    return v;
  },
  async settle(p, r) {
    emit({step: "settling"});
    const t = Date.now();
    const s = await inner.settle(p, r);
    emit({step: "settle", ok: s.success, ms: Date.now() - t, tx: s.transaction, detail: s.success ? undefined : s.errorMessage});
    return s;
  },
};
const rs = new x402ResourceServer(facilitator).register(NET, new ShieldedServerScheme({usdc}));

const app = express();
app.set("trust proxy", true);
app.use(
  paymentMiddleware(
    {
      "GET /api/weather": {
        accepts: {scheme: "shielded", network: NET, payTo: me, maxTimeoutSeconds: 300, price: {amount: PRICE.toString(), asset: usdc, extra: {paymentModes: ["direct", "refundable"]}}},
        description: "Weather for agents, paid privately per request",
      },
    } as never,
    rs,
  ),
);
app.get("/api/weather", (_q, res) => {
  res.json({city: "Waterloo, ON", forecast: "light snow", tempC: -3, paidPrivately: true, at: new Date().toISOString()});
});

// bundle upload only; /v1/relay stays private
const relayerApp = relayer.app();
app.use("/relayer", (req, res, next) => (req.path === "/v1/bundles" && req.method === "POST" ? relayerApp(req, res, next) : res.status(404).end()));

// ---- one demo run -----------------------------------------------------------------------
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const runsByDay = new Map<string, number>();
const lastByIp = new Map<string, number>();
let busy = false;
let waiting = 0;

async function ensureMerchantLeaf() {
  await vendors.sync();
  const now = (await publicClient.getBlock()).timestamp;
  if (vendors.leaves.some((l) => l.wallet.toLowerCase() === me.toLowerCase() && l.expiry > now + 86400n)) return null;
  const vendorId = (await read(dep.vendorRegistry as Address, vendorRegistryAbi, "computeVendorId", [DOMAIN])) as Hex;
  const h = await send(dep.vendorTree as Address, vendorTreeAbi, "publish", [vendorId, me]);
  await vendors.sync();
  return h;
}

async function runDemo(as: "agent" | "wallet", out: Emit) {
  const t0 = Date.now();
  emit = out;
  try {
    const leafTx = await ensureMerchantLeaf();
    if (leafTx) out({step: "info", detail: "refreshed the merchant's verified-vendor leaf (they expire after 7 days)", tx: leafTx});
    const aspTx = await syncAssociationSet(asp);
    if (aspTx) out({step: "info", detail: "published a new association-set root (a deposit arrived since the last run)", tx: aspTx});

    let payer = as === "agent" ? agent : human;
    if (as === "agent") {
      await agent.refresh();
      const b = agent.budgetNote()?.note;
      const now = (await publicClient.getBlock()).timestamp;
      const available = !b ? 0n : now / policy.periodSeconds > b.period ? policy.periodBudget : b.remaining;
      if (available < PRICE || agent.balance(usdc) < PRICE) {
        out({step: "info", detail: `the agent's daily budget is used up (${$(available)} left; refunds restore balance, not budget), so a plain shielded wallet pays this time`});
        payer = human;
      }
    }
    const isAgent = payer === agent;
    out({step: "start", payer: isAgent ? "agent" : "wallet", price: Number(PRICE) / 1e6});

    // instrumented fetch: shows the real HTTP exchange the x402 client performs
    const loggingFetch: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const paid = req.headers.has("payment-signature") || req.headers.has("x-payment");
      const t = Date.now();
      const res = await fetch(req);
      const url = new URL(req.url);
      if (url.pathname === "/api/weather") {
        if (res.status === 402) {
          const header = res.headers.get("payment-required");
          let accepts: unknown;
          try {
            accepts = header ? JSON.parse(Buffer.from(header, "base64").toString()).accepts?.[0] : undefined;
          } catch {
            accepts = undefined;
          }
          out({step: "402", ms: Date.now() - t, accepts});
        } else out({step: "response", status: res.status, paid, ms: Date.now() - t});
      }
      return res;
    };
    const base = new ShieldedClientScheme({wallet: payer, maxFee: U(0.01), terms: {mode: "refundable"}});
    const scheme = {
      scheme: base.scheme,
      async createPaymentPayload(v: number, r: Parameters<typeof base.createPaymentPayload>[1]) {
        out({step: "proving", circuit: isAgent ? "policy_pay" : "transact"});
        const t = Date.now();
        // our own client uploads over loopback; outside clients use the public URL from the 402
        const p = await base.createPaymentPayload(v, {...r, extra: {...r.extra, bundleUploadUrl: `${LOCAL}/relayer/v1/bundles`}});
        const ref = (p.payload as {bundleRef?: string}).bundleRef;
        const bundle = ref ? relayer.bundles.get(ref) : undefined;
        out({step: "proof", ms: Date.now() - t, circuit: isAgent ? "policy_pay" : "transact", bytes: bundle ? JSON.stringify(toWire(bundle)).length : undefined, ref});
        return p;
      },
    };
    const pay = wrapFetchWithPayment(loggingFetch, new x402Client().register(NET, scheme as never));
    const res = await pay(`${LOCAL}/api/weather`);
    if (res.status !== 200) throw new Error(`API answered ${res.status}`);
    out({step: "data", body: await res.json()});

    // what the chain shows for that transaction
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    const txHash = settle.transaction as Hex;
    const [tx, receipt] = await Promise.all([publicClient.getTransaction({hash: txHash}), publicClient.getTransactionReceipt({hash: txHash})]);
    const transfers = receipt.logs
      .filter((l) => l.address.toLowerCase() === usdc.toLowerCase())
      .map((l) => decodeEventLog({abi: [transferEvent], data: l.data, topics: l.topics}).args);
    out({
      step: "chain", tx: txHash, block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed),
      from: tx.from, to: tx.to, transfers: transfers.map((t) => ({from: t.from, to: t.to, usdc: Number(t.value) / 1e6})),
    });

    // keep the demo free: the merchant refunds by request id, into a note only the payer can open
    await payer.refresh();
    const rec = payer.payments().find((p) => p.txHash.toLowerCase() === txHash.toLowerCase());
    if (rec) {
      const r = await merchantRefund(wallet, publicClient, pool, rec, PRICE);
      out({step: "refund", tx: r.hash, gasUsed: Number(r.gasUsed)});
    }
    out({step: "done", ms: Date.now() - t0});
  } catch (e) {
    out({step: "error", detail: (e as Error).message.split("\n")[0]});
  } finally {
    emit = () => {};
  }
}

app.get("/demo/run", async (req, res) => {
  // no-transform stops proxies (Cloudflare) from compressing, and so buffering, the stream; the
  // 2 KB comment pushes past any first-chunk buffer so steps arrive as they happen
  res.set({"content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no"});
  res.flushHeaders();
  res.write(`: ${" ".repeat(2048)}\n\n`);
  const send = (e: Record<string, unknown>) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const end = () => res.end();
  const ip = req.ip ?? "?";
  const day = new Date().toISOString().slice(0, 10);
  if (Date.now() - (lastByIp.get(ip) ?? 0) < 20_000) return send({step: "error", detail: "one run per visitor every 20 seconds"}), end();
  if ((runsByDay.get(day) ?? 0) >= MAX_PER_DAY) return send({step: "error", detail: "the demo's daily limit is reached; try tomorrow"}), end();
  if ((await publicClient.getBalance({address: me})) < MIN_ETH) return send({step: "error", detail: "the demo relayer is out of testnet gas; try later"}), end();
  if (waiting >= 5) return send({step: "error", detail: "busy: several runs are queued, try again in a minute"}), end();
  lastByIp.set(ip, Date.now());
  waiting++;
  if (busy) send({step: "queued", ahead: waiting - 1});
  while (busy) await new Promise((ok) => setTimeout(ok, 500));
  busy = true;
  waiting--;
  runsByDay.set(day, (runsByDay.get(day) ?? 0) + 1);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 10_000);
  try {
    await runDemo(req.query.as === "wallet" ? "wallet" : "agent", send);
  } finally {
    clearInterval(keepalive);
    busy = false;
    end();
  }
});

// public pool stats, cached
const statsSync = new PoolSync(publicClient, pool, fromBlock);
let stats: {at: number; body: unknown} = {at: 0, body: null};
app.get("/demo/stats", async (_q, res) => {
  if (Date.now() - stats.at > 15_000) {
    await statsSync.sync();
    stats = {
      at: Date.now(),
      body: {
        pool, paymentBook: (await publicClient.readContract({address: pool, abi: [parseAbiItem("function paymentBook() view returns (address)")], functionName: "paymentBook"})),
        vendorTree: dep.vendorTree, associationSet: dep.associationSet, usdc, merchant: me,
        deposits: statsSync.deposits.size, notes: statsSync.tree.size, spent: statsSync.nullifiers.size,
        payments: statsSync.payments.size, runsToday: runsByDay.get(new Date().toISOString().slice(0, 10)) ?? 0, maxPerDay: MAX_PER_DAY,
      },
    };
  }
  res.json(stats.body);
});

app.use(express.static(join(ZK_DIR, "client", "demo")));
app.listen(PORT, "127.0.0.1", () => console.log(`demo on ${LOCAL} (public: ${PUBLIC_URL})`));
process.on("SIGTERM", async () => {
  await prover.destroy();
  process.exit(0);
});
