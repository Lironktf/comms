/**
 * Recursive aggregation: one proof for N = 2, 4 or 8 transact payments (docs/aggregation.md).
 *
 * The payer proves its transact statement twice: with the EVM target (what `transact`, `pay`
 * and `batch` verify) and with the `noir-recursive` target (what this aggregator consumes).
 * The aggregator builds a binary tree over the recursion proofs:
 *
 *   leaves  aggregate_2(pi_0, pi_1)  ...      digest = K(pi_0 || pi_1)
 *   nodes   aggregate_4(d_0, d_1)    ...      digest = K(d_0 || d_1)
 *   root    aggregate_8 (or the top level for N = 2 / 4), proven with the EVM target
 *
 * K(words) = keccak256(32-byte big-endian words) mod p, which the pool recomputes from the
 * payments' calldata (ShieldedPool.settleAggregated / AggregationModule).
 *
 * Two proving backends: "native" runs the bb 5.2.1 binary (faster, needs it installed),
 * "wasm" runs bb.js in-process.
 */
import {Barretenberg, UltraHonkBackend} from "@aztec/bb.js";
import {Noir, type CompiledCircuit, type InputMap} from "@noir-lang/noir_js";
import {execFile} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir, homedir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {concat, keccak256, toHex, type Hex} from "viem";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");
/** bb v5.2.1 RECURSIVE_ZK_PROOF_LENGTH (barretenberg/noir/bb_proof_verification at v5.2.1) */
export const RECURSIVE_PROOF_FIELDS = 458;
export const AGGREGATE_SIZES = [2, 4, 8] as const;
export type AggregateSize = (typeof AGGREGATE_SIZES)[number];

/** A payer's recursion-target transact proof: 458 field elements + its 12 public inputs. */
export interface RecursiveProof {
  proof: Hex; // 458 * 32 bytes
  publicInputs: Hex[]; // 12, bytes32 hex, transact declaration order
}

export interface AggregateResult {
  /** EVM-target proof of the root circuit: settleAggregated's `proof` argument */
  proof: Hex;
  digest: bigint;
  /** per proving step, in order: leaves, then each level up to the root */
  steps: {circuit: string; ms: number}[];
  totalMs: number;
}

/** K(words) = keccak256(be32(w_0) || ... ) mod p */
export function digestWords(words: readonly (bigint | Hex)[]): bigint {
  return BigInt(keccak256(concat(words.map((w) => toHex(BigInt(w), {size: 32}))))) % FIELD;
}

/** The root digest the pool recomputes: a binary tree of K over pairs of payments. */
export function aggregateDigest(publicInputs: readonly (readonly Hex[])[]): bigint {
  const n = publicInputs.length;
  if (!AGGREGATE_SIZES.includes(n as AggregateSize)) throw new Error(`aggregate size must be 2, 4 or 8, got ${n}`);
  let level: bigint[] = [];
  for (let i = 0; i < n; i += 2) level.push(digestWords([...publicInputs[i]!, ...publicInputs[i + 1]!]));
  while (level.length > 1) {
    const up: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) up.push(digestWords([level[i]!, level[i + 1]!]));
    level = up;
  }
  return level[0]!;
}

const fields = (bytes: Uint8Array): Hex[] => {
  const out: Hex[] = [];
  for (let k = 0; k < bytes.length; k += 32) out.push(`0x${Buffer.from(bytes.subarray(k, k + 32)).toString("hex")}`);
  return out;
};
const hexBytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

type Target = "evm" | "noir-recursive";

export class Aggregator {
  private api: Barretenberg | null = null;
  private readonly circuits = new Map<string, {json: CompiledCircuit; noir: Noir; backend?: UltraHonkBackend}>();
  private readonly dir: string;
  private readonly bb: string;

  constructor(private readonly opts: {backend?: "native" | "wasm"; threads?: number; artifactsDir?: string; bbPath?: string} = {}) {
    this.dir = opts.artifactsDir ?? ARTIFACTS;
    this.bb = opts.bbPath ?? process.env.BB_BIN ?? join(homedir(), ".bb", "bb");
  }

  get backend() {
    return this.opts.backend ?? "native";
  }

  private load(name: string) {
    let c = this.circuits.get(name);
    if (!c) {
      const json = JSON.parse(readFileSync(join(this.dir, `${name}.json`), "utf8")) as CompiledCircuit;
      c = {json, noir: new Noir(json)};
      this.circuits.set(name, c);
    }
    return c;
  }

  /** recursion vk of `name` as fields, and its hash */
  private childKey(name: string): {vk: Hex[]; hash: Hex} {
    return {
      vk: fields(readFileSync(join(this.dir, `${name}.rvk`))),
      hash: `0x${readFileSync(join(this.dir, `${name}.rvk_hash`)).toString("hex")}`,
    };
  }

  private async prove(name: string, inputs: InputMap, target: Target): Promise<{proof: Uint8Array; ms: number}> {
    const c = this.load(name);
    const t0 = performance.now();
    const {witness} = await c.noir.execute(inputs);
    let proof: Uint8Array;
    if (this.backend === "native") {
      const tmp = mkdtempSync(join(tmpdir(), `grayr-${name}-`));
      writeFileSync(join(tmp, "witness.gz"), witness);
      const vk = join(this.dir, `${name}.${target === "evm" ? "vk" : "rvk"}`);
      await promisify(execFile)(this.bb, ["prove", "-b", join(this.dir, `${name}.json`), "-w", join(tmp, "witness.gz"), "-k", vk, "-o", tmp, "-t", target], {maxBuffer: 1 << 26});
      proof = readFileSync(join(tmp, "proof"));
      rmSync(tmp, {recursive: true, force: true});
    } else {
      if (!this.api) this.api = await Barretenberg.new({threads: this.opts.threads ?? 4});
      c.backend ??= new UltraHonkBackend(c.json.bytecode, this.api);
      proof = (await c.backend.generateProof(witness, {verifierTarget: target})).proof;
    }
    return {proof, ms: performance.now() - t0};
  }

  /** One proof for `inner` (2, 4 or 8 recursion-target transact proofs, in settlement order). */
  async aggregate(inner: readonly RecursiveProof[]): Promise<AggregateResult> {
    const n = inner.length;
    if (!AGGREGATE_SIZES.includes(n as AggregateSize)) throw new Error(`aggregate size must be 2, 4 or 8, got ${n}`);
    for (const p of inner) {
      if (p.publicInputs.length !== 12) throw new Error("not a transact proof (expected 12 public inputs)");
      if ((p.proof.length - 2) / 64 !== RECURSIVE_PROOF_FIELDS) throw new Error("not a recursion-target proof (expected 458 fields)");
    }
    const t0 = performance.now();
    const steps: AggregateResult["steps"] = [];
    const tx = this.childKey("transact");
    // level 0: aggregate_2 over pairs of payments
    let level: {proof: Uint8Array; digest: bigint}[] = [];
    for (let i = 0; i < n; i += 2) {
      const a = inner[i]!;
      const b = inner[i + 1]!;
      const pis = [a.publicInputs, b.publicInputs];
      const digest = digestWords([...a.publicInputs, ...b.publicInputs]);
      const {proof, ms} = await this.prove(
        "aggregate_2",
        {vk: tx.vk, key_hash: tx.hash, proofs: [fields(hexBytes(a.proof)), fields(hexBytes(b.proof))], public_inputs: pis, payments_digest: toHex(digest)},
        n === 2 ? "evm" : "noir-recursive",
      );
      steps.push({circuit: "aggregate_2", ms});
      level.push({proof, digest});
    }
    // levels above: aggregate_4, aggregate_8
    for (let size = 4; size <= n; size *= 2) {
      const child = this.childKey(`aggregate_${size / 2}`);
      const up: typeof level = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i]!;
        const r = level[i + 1]!;
        const digest = digestWords([l.digest, r.digest]);
        const {proof, ms} = await this.prove(
          `aggregate_${size}`,
          {vk: child.vk, key_hash: child.hash, proofs: [fields(l.proof), fields(r.proof)], child_digests: [toHex(l.digest), toHex(r.digest)], payments_digest: toHex(digest)},
          size === n ? "evm" : "noir-recursive",
        );
        steps.push({circuit: `aggregate_${size}`, ms});
        up.push({proof, digest});
      }
      level = up;
    }
    const root = level[0]!;
    return {proof: toHex(root.proof), digest: root.digest, steps, totalMs: performance.now() - t0};
  }

  async destroy(): Promise<void> {
    await this.api?.destroy();
    this.api = null;
    for (const c of this.circuits.values()) c.backend = undefined;
  }
}
