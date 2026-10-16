/**
 * Relayer: the mail carrier. It receives a proof bundle over HTTP, checks it pays the
 * relayer's fee, eth_call-simulates it (which verifies the PROOF onchain for free), and
 * submits it from its own address, paying gas in ETH and being reimbursed by the fee
 * inside the proof. It never holds user funds and can't alter anything: the proof binds
 * recipient, amount, fee and fee recipient. It learns "someone pays M $X" (public anyway),
 * never who. If it refuses or goes down, use another relayer or submit yourself.
 *
 * Batching: with `batch.maxSize > 1`, bundles are queued and flushed as ONE transaction
 * (pool.transactBatch / payWithPolicyBatch) every `windowMs` or when full: cheaper per
 * payment and it blurs timing (several payments, different merchants, one tx).
 */
import express, {type Express} from "express";
import {createHash} from "node:crypto";
import type {Address, Hex, PublicClient, WalletClient} from "viem";
import {parseBundle, toWire} from "./serde.js";
import {simulateBundle, submitBatch, submitBundle} from "./pool.js";
import type {Bundle} from "./wallet.js";

export interface RelayerConfig {
  pool: Address;
  chainId: bigint;
  wallet: WalletClient;
  publicClient: PublicClient;
  /** minimum fee per token (atomic units); tokens not listed are refused */
  minFee: Record<string, bigint>;
  batch?: {maxSize: number; windowMs: number};
}

export interface RelayResult {
  txHash: Hex;
  gasUsed: bigint;
  batchSize: number;
}

export function bundleFee(b: Bundle): {token: Address | null; fee: bigint} {
  switch (b.kind) {
    case "transact":
    case "authorize":
    case "swap":
      return {token: b.inputs.token, fee: b.inputs.fee};
    case "policyPay":
      return {token: b.inputs.token, fee: b.inputs.fee};
    case "initBudget":
      return {token: null, fee: 0n};
  }
}

/**
 * Content-addressed, short-lived store for proof bundles. An ~8 KB UltraHonk proof, once
 * JSON+base64 encoded into an x402 PAYMENT-SIGNATURE header, exceeds common header limits
 * (Node's default 16 KB total; nginx 8 KB buffers). So clients upload the bundle here and the
 * header carries only its id = sha256(bundle). The facilitator only ever reads its OWN store
 * (no fetching client-supplied URLs), and the id is the content hash, so it can't be swapped.
 */
export class BundleStore {
  private readonly m = new Map<string, {bundle: Bundle; expires: number}>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly max = 10_000) {}

  static idOf(b: Bundle): string {
    return createHash("sha256").update(JSON.stringify(toWire(b))).digest("hex");
  }

  put(b: Bundle): string {
    const now = Date.now();
    for (const [k, v] of this.m) if (v.expires < now) this.m.delete(k);
    if (this.m.size >= this.max) throw new Error("bundle store full");
    const id = BundleStore.idOf(b);
    this.m.set(id, {bundle: b, expires: now + this.ttlMs});
    return id;
  }

  get(id: string): Bundle | undefined {
    const e = this.m.get(id);
    return e && e.expires >= Date.now() ? e.bundle : undefined;
  }
}

export class Relayer {
  readonly address: Address;
  readonly bundles = new BundleStore();
  private queue: {bundle: Bundle; resolve: (r: RelayResult) => void; reject: (e: unknown) => void}[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly cfg: RelayerConfig) {
    this.address = cfg.wallet.account!.address;
  }

  info() {
    return {
      chainId: this.cfg.chainId.toString(),
      pool: this.cfg.pool,
      feeRecipient: this.address,
      minFee: Object.fromEntries(Object.entries(this.cfg.minFee).map(([t, f]) => [t.toLowerCase(), f.toString()])),
      batching: this.cfg.batch ?? null,
    };
  }

  /** Policy checks a relayer applies before spending gas. Throws with a reason. */
  async check(b: Bundle): Promise<void> {
    if (b.kind !== "initBudget") {
      const {token, fee} = bundleFee(b);
      const min = token ? this.cfg.minFee[token.toLowerCase()] ?? this.cfg.minFee[token] : undefined;
      if (min === undefined) throw new Error(`relayer does not accept fees in ${token}`);
      if (fee < min) throw new Error(`fee ${fee} below relayer minimum ${min}`);
      if (fee > 0n && b.ext.feeRecipient.toLowerCase() !== this.address.toLowerCase()) {
        throw new Error("bundle pays its fee to a different relayer");
      }
    }
    await simulateBundle(this.cfg.publicClient, this.cfg.pool, b, this.address);
  }

  async relay(b: Bundle): Promise<RelayResult> {
    await this.check(b);
    const batchable = (b.kind === "transact" || b.kind === "policyPay") && (this.cfg.batch?.maxSize ?? 1) > 1;
    if (!batchable) {
      const r = await submitBundle(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, b);
      return {txHash: r.hash, gasUsed: r.gasUsed, batchSize: 1};
    }
    return new Promise((resolve, reject) => {
      this.queue.push({bundle: b, resolve, reject});
      const sameKind = this.queue.filter((q) => q.bundle.kind === b.kind).length;
      if (sameKind >= this.cfg.batch!.maxSize) void this.flush();
      else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.cfg.batch!.windowMs);
    });
  }

  /** Submit everything queued, one transaction per bundle kind. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const items = this.queue;
    this.queue = [];
    for (const kind of ["transact", "policyPay"] as const) {
      const group = items.filter((q) => q.bundle.kind === kind);
      if (!group.length) continue;
      try {
        const r = await submitBatch(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, group.map((q) => q.bundle));
        for (const q of group) q.resolve({txHash: r.hash, gasUsed: r.gasUsed, batchSize: group.length});
      } catch (e) {
        // One bad bundle (e.g. a nullifier spent meanwhile) must not sink the others:
        // fall back to submitting individually.
        for (const q of group) {
          try {
            const r = await submitBundle(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, q.bundle);
            q.resolve({txHash: r.hash, gasUsed: r.gasUsed, batchSize: 1});
          } catch (err) {
            q.reject(err);
          }
        }
        void e;
      }
    }
  }

  /** HTTP API: GET /v1/info, POST /v1/relay {bundle}. */
  app(): Express {
    const app = express();
    app.use(express.json({limit: "256kb"}));
    app.get("/v1/info", (_req, res) => {
      res.json(this.info());
    });
    app.post("/v1/bundles", (req, res) => {
      try {
        res.json({id: this.bundles.put(parseBundle(req.body?.bundle))});
      } catch (e) {
        res.status(400).json({error: (e as Error).message});
      }
    });
    app.post("/v1/relay", async (req, res) => {
      let bundle: Bundle;
      try {
        bundle = parseBundle(req.body?.bundle);
      } catch (e) {
        res.status(400).json({error: (e as Error).message});
        return;
      }
      try {
        res.json(toWire(await this.relay(bundle)));
      } catch (e) {
        res.status(422).json({error: shortError(e)});
      }
    });
    return app;
  }
}

/** Client side: send a bundle to a relayer over HTTP. */
export async function relayViaHttp(url: string, bundle: Bundle): Promise<RelayResult> {
  const r = await fetch(`${url.replace(/\/$/, "")}/v1/relay`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({bundle: toWire(bundle)}),
  });
  const body = (await r.json()) as {error?: string; txHash?: Hex; gasUsed?: {$n: string}; batchSize?: number};
  if (!r.ok) throw new Error(`relayer refused: ${body.error}`);
  return {txHash: body.txHash!, gasUsed: BigInt(body.gasUsed!.$n), batchSize: body.batchSize!};
}

export function shortError(e: unknown): string {
  const m = (e as {shortMessage?: string; message?: string}).shortMessage ?? (e as Error).message ?? String(e);
  const custom = /reverted with the following reason:\s*\n?(.*)|Error: ([A-Za-z]+\(.*?\))/.exec((e as Error).message ?? "");
  return custom ? (custom[1] ?? custom[2] ?? m).trim() : m;
}

/** Upload a bundle to a facilitator's store; returns its content id (see BundleStore). */
export async function uploadBundle(url: string, bundle: Bundle): Promise<string> {
  const r = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({bundle: toWire(bundle)})});
  const body = (await r.json()) as {id?: string; error?: string};
  if (!r.ok || !body.id) throw new Error(`bundle upload refused: ${body.error}`);
  if (body.id !== BundleStore.idOf(bundle)) throw new Error("bundle store returned a wrong id");
  return body.id;
}
