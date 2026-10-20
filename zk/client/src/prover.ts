import {Barretenberg, UltraHonkBackend} from "@aztec/bb.js";
import {Noir, type CompiledCircuit, type InputMap} from "@noir-lang/noir_js";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export type CircuitName =
  | "transact" | "policy_pay" | "budget_init" | "ragequit" | "m0_commitment" | "m0_merkle"
  | "aggregate_2" | "aggregate_4" | "aggregate_8";

/** "evm": verified by the Solidity verifiers. "noir-recursive": Poseidon2 transcript, verified
 *  inside another circuit (the aggregation tree, src/aggregator.ts). Both are zero-knowledge. */
export type ProofTarget = "evm" | "noir-recursive";

export interface Proof {
  /** raw proof bytes as 0x-hex: what the Solidity verifier's `proof` argument takes */
  proof: `0x${string}`;
  /** public inputs in circuit declaration order (bytes32 hex) */
  publicInputs: `0x${string}`[];
  /** wall-clock timings, for benchmarks */
  timings: {witnessMs: number; proveMs: number};
}

const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");

/**
 * Proves circuits with Noir (witness generation) + Barretenberg UltraHonk (proof).
 *
 * `verifierTarget: "evm"` = keccak Fiat-Shamir transcript, so the onchain verifier can
 * recompute challenges cheaply, AND zero-knowledge masking, so the proof reveals nothing
 * about the private inputs. ("evm-no-zk" would be smaller but is NOT private.)
 */
export class Prover {
  private api: Barretenberg | null = null;
  private readonly circuits = new Map<CircuitName, {noir: Noir; backend: UltraHonkBackend | null; json: CompiledCircuit}>();

  constructor(private readonly opts: {threads?: number; artifactsDir?: string} = {}) {}

  private async getApi(): Promise<Barretenberg> {
    if (!this.api) this.api = await Barretenberg.new({threads: this.opts.threads ?? 4});
    return this.api;
  }

  private async load(name: CircuitName) {
    let c = this.circuits.get(name);
    if (!c) {
      const json = JSON.parse(readFileSync(join(this.opts.artifactsDir ?? ARTIFACTS, `${name}.json`), "utf8")) as CompiledCircuit;
      c = {noir: new Noir(json), backend: null, json};
      this.circuits.set(name, c);
    }
    if (!c.backend) c.backend = new UltraHonkBackend(c.json.bytecode, await this.getApi());
    return c;
  }

  /** Run the circuit on `inputs` (fails fast with the circuit's assertion message if the
   *  statement is false), then produce the proof. */
  async prove(name: CircuitName, inputs: InputMap, target: ProofTarget = "evm"): Promise<Proof> {
    const c = await this.load(name);
    const t0 = performance.now();
    const {witness} = await c.noir.execute(inputs);
    const t1 = performance.now();
    const pd = await c.backend!.generateProof(witness, {verifierTarget: target});
    const t2 = performance.now();
    return {
      proof: `0x${Buffer.from(pd.proof).toString("hex")}`,
      publicInputs: pd.publicInputs.map((x) => `0x${BigInt(x).toString(16).padStart(64, "0")}` as `0x${string}`),
      timings: {witnessMs: t1 - t0, proveMs: t2 - t1},
    };
  }

  /** Offchain verification (what a facilitator does before spending gas). */
  async verify(name: CircuitName, proof: Pick<Proof, "proof" | "publicInputs">, target: ProofTarget = "evm"): Promise<boolean> {
    const c = await this.load(name);
    try {
      return await c.backend!.verifyProof(
        {proof: Uint8Array.from(Buffer.from(proof.proof.slice(2), "hex")), publicInputs: proof.publicInputs},
        {verifierTarget: target},
      );
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    await this.api?.destroy();
    this.api = null;
    for (const c of this.circuits.values()) c.backend = null;
  }
}
