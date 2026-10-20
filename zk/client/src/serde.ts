import type {Bundle} from "./wallet.js";

/**
 * JSON encoding for bundles sent over HTTP (relayer API, x402 PAYMENT-SIGNATURE header).
 * bigints are tagged {"$n":"123"} so they round-trip exactly; nothing else is transformed.
 */
export function toWire(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? {$n: v.toString()} : v)));
}

export function fromWire<T = unknown>(x: unknown): T {
  return JSON.parse(JSON.stringify(x), (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$n === "string" ? BigInt(v.$n) : v,
  ) as T;
}

const KINDS = new Set(["transact", "pay", "policyPay", "initBudget", "authorize", "swap"]);

/** Structural validation of an untrusted bundle (the proof/contract do the real checking). */
export function parseBundle(x: unknown): Bundle {
  const b = fromWire<Bundle>(x);
  if (!b || typeof b !== "object" || !KINDS.has((b as {kind: string}).kind)) throw new Error("bad bundle kind");
  if (typeof b.proof !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.proof)) throw new Error("bad proof");
  const rp = (b as {recursiveProof?: unknown}).recursiveProof;
  if (rp !== undefined && (typeof rp !== "string" || !/^0x[0-9a-fA-F]+$/.test(rp) || (b.kind !== "transact" && b.kind !== "pay"))) {
    throw new Error("bad recursiveProof");
  }
  if (!b.ext || typeof b.ext.deadline !== "bigint") throw new Error("bad ext");
  return b;
}
