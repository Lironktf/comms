/**
 * M2 + M4 end to end: an agent privately pays x402-protected APIs on anvil, through the
 * OFFICIAL @x402 v2 packages (client fetch wrapper, express middleware, facilitator).
 *
 *  Path A: scheme `shielded` (our server + facilitator plugin), plain wallet AND policy agent.
 *  Path B: scheme `exact`, completely unmodified @x402/evm server + facilitator; the payer is
 *          the pool (EIP-1271), pre-authorized by a ZK proof.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
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
import {approve, erc20Balance, increaseTime, mintUsdc, registerVerifiedVendor, startDevnet, type Devnet} from "../src/devnet.js";
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
import {
  localFacilitatorClient, PoolExactClientScheme, ShieldedClientScheme, ShieldedFacilitatorScheme, ShieldedServerScheme,
} from "../src/x402/index.js";

const NET = "eip155:31337" as const;
const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const SEED = new Uint8Array(32).fill(4);
const PAYER = 1, RELAYER = 2, MERCHANT = 4, LEGACY_MERCHANT = 5, FACILITATOR_B = 6;

let d: Devnet;
let prover: Prover;
let asp: AspService;
let relayer: Relayer;
let servers: Server[] = [];
let merchant: Address;
let legacyMerchant: Address;

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(`http://127.0.0.1:${(s.address() as {port: number}).port}`));
    servers.push(s);
  });
}

async function depositFor(w: ShieldedWallet, amount: bigint, opts: {policy?: bigint; to?: ShieldedWallet} = {}) {
  await mintUsdc(d, d.address(PAYER), amount);
  await approve(d, PAYER, d.deployment.usdc, d.deployment.pool, amount);
  const dep = w.prepareDeposit(d.deployment.usdc, amount, {to: opts.to?.address, policy: opts.policy});
  const wc = d.wallet(PAYER);
  await d.publicClient.waitForTransactionReceipt({
    hash: await wc.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "deposit", args: [d.deployment.usdc, amount, dep.inner, dep.encryptedNote], account: wc.account!, chain: d.chain}),
  });
  if (await asp.refresh()) await asp.publish(d.wallet(0), d.publicClient);
}

beforeAll(async () => {
  d = await startDevnet(8613);
  prover = new Prover();
  asp = new AspService(new PoolSync(d.publicClient, d.deployment.pool), d.deployment.associationSet, blocklistRule([]));
  merchant = d.address(MERCHANT);
  legacyMerchant = d.address(LEGACY_MERCHANT);
  await registerVerifiedVendor(d, {owner: MERCHANT, domain: "api.weather.example", wallet: merchant, level: 3, categories: 0b010n});
  relayer = new Relayer({
    pool: d.deployment.pool, chainId: 31337n, wallet: d.wallet(RELAYER), publicClient: d.publicClient,
    minFee: {[d.deployment.usdc.toLowerCase()]: USDC(0.01)},
  });
});

afterAll(async () => {
  for (const s of servers) s.close();
  await prover?.destroy();
  d?.stop();
});

describe("Path A: x402 `shielded` scheme", () => {
  let baseUrl: string;

  beforeAll(async () => {
    const relayerUrl = await listen(relayer.app()); // the facilitator's relayer API (bundle upload)
    const facilitator = new x402Facilitator().register(NET, new ShieldedFacilitatorScheme(relayer, {network: NET, token: d.deployment.usdc, publicUrl: relayerUrl}));
    const server = new x402ResourceServer(localFacilitatorClient(facilitator)).register(NET, new ShieldedServerScheme({usdc: d.deployment.usdc}));
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /forecast": {
            accepts: {scheme: "shielded", network: NET, payTo: merchant, price: {amount: USDC(0.25).toString(), asset: d.deployment.usdc}, maxTimeoutSeconds: 300},
            description: "Weather forecast API",
          },
        } as never,
        server,
      ),
    );
    app.get("/forecast", (_req, res) => {
      res.json({city: "Waterloo", forecast: "snow", servedBy: "api.weather.example"});
    });
    baseUrl = await listen(app);
  });

  it("an unpaid request gets HTTP 402 advertising the shielded scheme", async () => {
    const r = await fetch(`${baseUrl}/forecast`);
    expect(r.status).toBe(402);
    const required = JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString());
    expect(required.accepts[0].scheme).toBe("shielded");
    expect(required.accepts[0].extra.pool.toLowerCase()).toBe(d.deployment.pool.toLowerCase());
  });

  it("a plain shielded wallet pays; the merchant gets ordinary USDC from the POOL", async () => {
    const w = new ShieldedWallet({keys: deriveSpendingKeys(SEED), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    await depositFor(w, USDC(10));
    const client = new x402Client().register(NET, new ShieldedClientScheme({wallet: w, maxFee: USDC(0.05)}));
    const pay = wrapFetchWithPayment(fetch, client);
    const before = await erc20Balance(d, d.deployment.usdc, merchant);

    const res = await pay(`${baseUrl}/forecast`);
    expect(res.status).toBe(200);
    expect((await res.json()).forecast).toBe("snow");
    expect(await erc20Balance(d, d.deployment.usdc, merchant)).toBe(before + USDC(0.25));

    // The settlement tx: the token Transfer comes FROM the pool. The payer's address appears nowhere.
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    const receipt = await d.publicClient.getTransactionReceipt({hash: settle.transaction as `0x${string}`});
    expect(receipt.from.toLowerCase()).toBe(relayer.address.toLowerCase());
    const payment = receipt.logs
      .filter((l) => l.address.toLowerCase() === d.deployment.pool.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({abi: shieldedPoolAbi, data: l.data, topics: l.topics});
        } catch {
          return null;
        }
      })
      .find((e) => e?.eventName === "PublicPayment");
    expect(payment).toBeTruthy();
    const logsText = JSON.stringify(receipt.logs, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    expect(logsText.includes(d.address(PAYER).slice(2).toLowerCase())).toBe(false);
    await w.refresh();
    expect(w.balance(d.deployment.usdc)).toBe(USDC(10) - USDC(0.25) - USDC(0.01));
  });

  it("a policy-bound AGENT pays the same API (policy enforced in the proof)", async () => {
    const admin = deriveAdminKeys(SEED);
    const policy: PolicyParams = {
      adminPk: admin.adminPk, token: BigInt(d.deployment.usdc), maxPerPayment: USDC(1), maxFee: USDC(0.02),
      periodBudget: USDC(5), periodSeconds: 86400n, minVendorLevel: 2n, categoryMask: 0b010n, requireVerifiedVendor: true,
    };
    const agent = new AgentWallet({
      keys: deriveAgentKeys(SEED, 0), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n,
      pool: d.deployment.pool, prover, asp, policy, vendors: new VendorTreeSync(d.publicClient, d.deployment.vendorTree),
    });
    const human = new ShieldedWallet({keys: deriveSpendingKeys(SEED), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    await depositFor(human, USDC(3), {to: agent as unknown as ShieldedWallet, policy: policyHash(policy)});
    const ts = (await d.publicClient.getBlock()).timestamp;
    await submitBundle(d.wallet(RELAYER), d.publicClient, d.deployment.pool,
      await prepareBudgetInit({prover, admin, policy, agent: agent.address, chainId: 31337n, pool: d.deployment.pool, timestamp: ts}));

    const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, new ShieldedClientScheme({wallet: agent, maxFee: USDC(0.02)})));
    const before = await erc20Balance(d, d.deployment.usdc, merchant);
    const res = await pay(`${baseUrl}/forecast`);
    expect(res.status).toBe(200);
    expect(await erc20Balance(d, d.deployment.usdc, merchant)).toBe(before + USDC(0.25));
    await agent.refresh();
    expect(agent.budgetNote()!.note.kind === "budget" && agent.budgetNote()!.note.remaining).toBe(USDC(5) - USDC(0.26));
  });

  it("the facilitator rejects a proof that pays someone else / less", async () => {
    const w = new ShieldedWallet({keys: deriveSpendingKeys(SEED), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    const cheat = await w.preparePayment({
      token: d.deployment.usdc, amount: USDC(0.01), recipient: merchant, fee: USDC(0.01), feeRecipient: relayer.address,
      requestId: `0x${"ab".repeat(32)}`,
    });
    const fac = new ShieldedFacilitatorScheme(relayer, {network: NET, token: d.deployment.usdc});
    const req = {scheme: "shielded", network: NET, asset: d.deployment.usdc, amount: USDC(0.25).toString(), payTo: merchant, maxTimeoutSeconds: 300, extra: fac.getExtra(NET)};
    const {toWire} = await import("../src/serde.js");
    const v = await fac.verify({x402Version: 2, accepted: req, payload: {bundle: toWire(cheat)}} as never, req as never);
    expect(v.isValid).toBe(false);
    expect(v.invalidMessage).toMatch(/amount/);
  });
});

describe("Path B: an UNMODIFIED x402 `exact` merchant, paid by the pool via EIP-1271", () => {
  let baseUrl: string;

  beforeAll(async () => {
    const fw = d.wallet(FACILITATOR_B);
    // Stock @x402/evm exact facilitator, wired to anvil. Nothing shielded-pool-specific here.
    const signer = toFacilitatorEvmSigner({
      address: fw.account!.address,
      readContract: (a) => d.publicClient.readContract(a as never),
      verifyTypedData: (a) => d.publicClient.verifyTypedData(a as never),
      writeContract: (a) => fw.writeContract({...(a as object), account: fw.account!, chain: d.chain} as never),
      sendTransaction: (a) => fw.sendTransaction({...a, account: fw.account!, chain: d.chain}),
      waitForTransactionReceipt: (a) => d.publicClient.waitForTransactionReceipt(a),
      getCode: (a) => d.publicClient.getCode(a),
    });
    const facilitator = new x402Facilitator().register(NET, new ExactFacilitator(signer));
    const server = new x402ResourceServer(localFacilitatorClient(facilitator)).register(NET, new ExactServer());
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /quote": {
            accepts: {
              scheme: "exact", network: NET, payTo: legacyMerchant, maxTimeoutSeconds: 300,
              price: {amount: USDC(0.5).toString(), asset: d.deployment.usdc, extra: {name: "USDC", version: "2"}},
            },
            description: "A legacy x402 merchant that knows nothing about shielded pools",
          },
        } as never,
        server,
      ),
    );
    app.get("/quote", (_req, res) => {
      res.json({quote: 42});
    });
    baseUrl = await listen(app);
  });

  it("the pool pays a standard exact merchant; the merchant's facilitator settles normally", async () => {
    const w = new ShieldedWallet({keys: deriveSpendingKeys(new Uint8Array(32).fill(5)), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    await depositFor(w, USDC(5));
    const scheme = new PoolExactClientScheme({
      wallet: w, fee: USDC(0.01), feeRecipient: relayer.address, publicClient: d.publicClient,
      relay: (b) => relayer.relay(b),
    });
    const pay = wrapFetchWithPayment(fetch, new x402Client().register(NET, scheme));
    const before = await erc20Balance(d, d.deployment.usdc, legacyMerchant);
    const res = await pay(`${baseUrl}/quote`);
    expect(res.status).toBe(200);
    expect((await res.json()).quote).toBe(42);
    expect(await erc20Balance(d, d.deployment.usdc, legacyMerchant)).toBe(before + USDC(0.5));
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    const receipt = await d.publicClient.getTransactionReceipt({hash: settle.transaction as `0x${string}`});
    expect(receipt.from.toLowerCase()).toBe(d.address(FACILITATOR_B).toLowerCase()); // the merchant's own facilitator
    await w.refresh();
    expect(w.balance(d.deployment.usdc)).toBe(USDC(5) - USDC(0.5) - USDC(0.01));
  });

  it("an expired, unused authorization is refunded into a new private note", async () => {
    const w = new ShieldedWallet({keys: deriveSpendingKeys(new Uint8Array(32).fill(6)), sync: new PoolSync(d.publicClient, d.deployment.pool), chainId: 31337n, pool: d.deployment.pool, prover, asp});
    await depositFor(w, USDC(2));
    const now = (await d.publicClient.getBlock()).timestamp;
    const b = await w.prepareAuthorization({
      token: d.deployment.usdc, amount: USDC(1), to: legacyMerchant, validAfter: now - 60n, validBefore: now + 120n,
      nonce: `0x${"cd".repeat(32)}`, fee: USDC(0.01), feeRecipient: relayer.address,
    });
    await relayer.relay(b);
    await w.refresh();
    expect(w.balance(d.deployment.usdc)).toBe(USDC(0.99)); // 1 USDC reserved for the authorization
    // the merchant never collects; after validBefore anyone can trigger the refund
    await increaseTime(d, 200);
    const sync = new PoolSync(d.publicClient, d.deployment.pool);
    await sync.sync();
    const [digest] = [...sync.authorizations.keys()].filter((k) => sync.authorizations.get(k)!.nonce === `0x${"cd".repeat(32)}`);
    const rw = d.wallet(RELAYER);
    await d.publicClient.waitForTransactionReceipt({
      hash: await rw.writeContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "reclaimAuthorization", args: [digest!], account: rw.account!, chain: d.chain}),
    });
    await w.refresh();
    expect(w.balance(d.deployment.usdc)).toBe(USDC(1.99));
    // and the digest is dead: the pool no longer vouches for it
    const v = await d.publicClient.readContract({address: d.deployment.pool, abi: shieldedPoolAbi, functionName: "isValidSignature", args: [digest!, "0x"]});
    expect(v).toBe("0xffffffff");
  });
});
