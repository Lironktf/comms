/**
 * Relayer: the mail carrier. It receives a proof bundle over HTTP, checks it pays the
 * relayer's fee, eth_call-simulates it (which verifies the PROOF onchain for free), and
 * submits it from its own address, paying gas in ETH and being reimbursed by the fee
 * inside the proof. It never holds user funds and can't alter anything: the proof binds
 * recipient, amount, fee and fee recipient. It learns "someone pays M $X" (public anyway),
 * never who. If it refuses or goes down, use another relayer or submit yourself.
 *
 * Batching: with `batch.maxSize > 1`, payment bundles (transact, pay, policyPay, in any mix)
 * are queued and flushed as ONE pool.batch transaction every `windowMs` or when full: cheaper
 * per payment, and it blurs timing (several payers, different merchants, one tx).
 *
 * Aggregation (docs/aggregation.md): with `aggregation` set, transact/pay bundles that carry a
 * recursion proof are settled 8, 4 or 2 per aggregate proof (pool.settleAggregated): one
 * verification for the whole group. Everything else in the flush, and any group whose
 * aggregation or settlement fails, goes through pool.batch as before. The fallback is logged
 * (`log`) and reported in RelayResult.mode / .fallback, never silent.
 *
 * A nullifier is reserved from intake until its bundle settles or fails, so a second bundle
 * spending the same note is refused at once instead of sinking a whole batch later.
 */
import express, {type Express} from "express";
import {createHash} from "node:crypto";
import type {Address, Hex, PublicClient, WalletClient} from "viem";
import {parseBundle, toWire} from "./serde.js";
import {
  BATCHABLE, isAggregatable, simulateAggregated, simulateBundle, submitAggregated, submitBatch, submitBundle,
  transactPublicInputs, type AggregatableBundle,
} from "./pool.js";
import type {Aggregator} from "./aggregator.js";
import type {Prover} from "./prover.js";
import type {Bundle} from "./wallet.js";

export interface RelayerConfig {
  pool: Address;
  chainId: bigint;
  wallet: WalletClient;
  publicClient: PublicClient;
  /** minimum fee per token (atomic units); tokens not listed are refused */
  minFee: Record<string, bigint>;
  batch?: {maxSize: number; windowMs: number};
  /** aggregate recursion-proof bundles (needs `batch`; maxSize 8 gives the largest aggregates).
   *  `prover` verifies each bundle's recursion proof at intake, so one bad proof can't make a
   *  whole aggregate fail after minutes of proving. */
  aggregation?: {aggregator: Aggregator; prover: Prover};
  /** where fallbacks and other operational events are reported (default: console.warn) */
  log?: (msg: string) => void;
}

export interface RelayResult {
  txHash: Hex;
  gasUsed: bigint;
  batchSize: number;
  /** how it settled: alone, in a pool.batch, or in a settleAggregated */
  mode: "single" | "batch" | "aggregated";
  /** why an aggregatable bundle did not settle aggregated (fallback to pool.batch) */
  fallback?: string;
  /** aggregation: proving time of the group's aggregate proof */
  aggregateMs?: number;
}

/** Every nullifier a bundle spends (what the pool will mark spent). */
export function bundleNullifiers(b: Bundle): bigint[] {
  switch (b.kind) {
    case "transact":
    case "pay":
    case "authorize":
    case "swap":
      return [...b.inputs.nullifiers];
    case "policyPay":
      return [...b.inputs.nullifiers, b.inputs.budgetNullifier];
    case "initBudget":
      return [];
  }
}

export function bundleFee(b: Bundle): {token: Address | null; fee: bigint} {
  switch (b.kind) {
    case "transact":
    case "pay":
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

interface Queued {
  bundle: Bundle;
  resolve: (r: RelayResult) => void;
  reject: (e: unknown) => void;
}

export class Relayer {
  readonly address: Address;
  readonly bundles = new BundleStore();
  private queue: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** nullifiers of every bundle accepted and not yet settled/failed */
  private readonly reserved = new Set<bigint>();

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
      aggregation: this.cfg.aggregation ? {sizes: [2, 4, 8], backend: this.cfg.aggregation.aggregator.backend} : null,
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
    if (this.cfg.aggregation && isAggregatable(b)) {
      const publicInputs = transactPublicInputs(b, this.cfg.chainId, this.cfg.pool);
      const ok = await this.cfg.aggregation.prover.verify("transact", {proof: b.recursiveProof, publicInputs}, "noir-recursive");
      if (!ok) throw new Error("recursiveProof does not verify for this bundle's statement");
    }
  }

  async relay(b: Bundle): Promise<RelayResult> {
    const nfs = bundleNullifiers(b);
    for (const n of nfs) if (this.reserved.has(n)) throw new Error(`nullifier ${n} is already queued at this relayer`);
    for (const n of nfs) this.reserved.add(n);
    const release = () => nfs.forEach((n) => this.reserved.delete(n));
    try {
      await this.check(b);
    } catch (e) {
      release();
      throw e;
    }
    const batchable = BATCHABLE.has(b.kind) && (this.cfg.batch?.maxSize ?? 1) > 1;
    if (!batchable) {
      try {
        const r = await submitBundle(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, b);
        return {txHash: r.hash, gasUsed: r.gasUsed, batchSize: 1, mode: "single"};
      } finally {
        release();
      }
    }
    const p = new Promise<RelayResult>((resolve, reject) => {
      this.queue.push({bundle: b, resolve, reject});
      if (this.queue.length >= this.cfg.batch!.maxSize) void this.flush();
      else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.cfg.batch!.windowMs);
    });
    return p.finally(release);
  }

  /** bundles accepted and waiting for the next flush */
  get queued(): number {
    return this.queue.length;
  }

  private log(msg: string) {
    (this.cfg.log ?? console.warn)(`[relayer] ${msg}`);
  }

  /** Settle everything queued: aggregated groups of 8/4/2 first (when enabled), then the rest
   *  (and any failed group) as one pool.batch transaction. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const group = this.queue;
    this.queue = [];
    if (!group.length) return;

    const rest: (Queued & {fallback?: string})[] = [];
    const candidates = this.cfg.aggregation ? group.filter((q) => isAggregatable(q.bundle)) : [];
    for (const q of group) if (!candidates.includes(q)) rest.push(q);
    // Re-check before spending proving time: a note spent since intake (e.g. by its payer
    // through the escape hatch) is dropped now instead of failing a whole aggregate later.
    const aggregatable: Queued[] = [];
    for (const q of candidates) {
      try {
        await simulateBundle(this.cfg.publicClient, this.cfg.pool, q.bundle, this.address);
        aggregatable.push(q);
      } catch (e) {
        this.log(`dropped a queued bundle that no longer settles: ${(e as Error).message.split("\n")[0]}`);
        q.reject(e);
      }
    }
    // largest sizes first, arrival order kept: 7 bundles -> 4 + 2, and 1 goes to the batch
    let i = 0;
    const chunks: Queued[][] = [];
    for (const size of [8, 4, 2]) {
      while (aggregatable.length - i >= size) {
        chunks.push(aggregatable.slice(i, i + size));
        i += size;
      }
    }
    for (const q of aggregatable.slice(i)) rest.push({...q, fallback: "no aggregate size fits the remainder"});

    for (const chunk of chunks) {
      const bundles = chunk.map((q) => q.bundle as AggregatableBundle);
      let stage = "proving";
      try {
        const agg = await this.cfg.aggregation!.aggregator.aggregate(
          bundles.map((b) => ({proof: b.recursiveProof, publicInputs: transactPublicInputs(b, this.cfg.chainId, this.cfg.pool)})),
        );
        stage = "simulating";
        await simulateAggregated(this.cfg.publicClient, this.cfg.pool, bundles, agg.proof, this.address);
        stage = "submitting";
        const r = await submitAggregated(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, bundles, agg.proof);
        for (const q of chunk) {
          q.resolve({txHash: r.hash, gasUsed: r.gasUsed, batchSize: chunk.length, mode: "aggregated", aggregateMs: agg.totalMs});
        }
      } catch (e) {
        const reason = `aggregation of ${chunk.length} failed while ${stage}: ${(e as Error).message.split("\n")[0]}`;
        this.log(`${reason}; falling back to pool.batch`);
        for (const q of chunk) rest.push({...q, fallback: reason});
      }
    }
    if (rest.length) await this.settleBatch(rest);
  }

  private async settleBatch(group: (Queued & {fallback?: string})[]): Promise<void> {
    try {
      const r = await submitBatch(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, group.map((q) => q.bundle));
      for (const q of group) q.resolve({txHash: r.hash, gasUsed: r.gasUsed, batchSize: group.length, mode: "batch", fallback: q.fallback});
    } catch (e) {
      // One bad bundle (e.g. a nullifier spent meanwhile) must not sink the others:
      // fall back to submitting individually.
      this.log(`pool.batch of ${group.length} failed (${(e as Error).message.split("\n")[0]}); submitting one by one`);
      for (const q of group) {
        try {
          const r = await submitBundle(this.cfg.wallet, this.cfg.publicClient, this.cfg.pool, q.bundle);
          q.resolve({txHash: r.hash, gasUsed: r.gasUsed, batchSize: 1, mode: "single", fallback: q.fallback});
        } catch (err) {
          q.reject(err);
        }
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
  const body = (await r.json()) as {error?: string; txHash?: Hex; gasUsed?: {$n: string}; batchSize?: number; mode?: RelayResult["mode"]; fallback?: string};
  if (!r.ok) throw new Error(`relayer refused: ${body.error}`);
  return {txHash: body.txHash!, gasUsed: BigInt(body.gasUsed!.$n), batchSize: body.batchSize!, mode: body.mode ?? "single", fallback: body.fallback};
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
