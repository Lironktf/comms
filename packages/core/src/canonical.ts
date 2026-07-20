import {keccak256, type Hex} from "viem";

/**
 * Canonical JSON serialization (RFC 8785 / JCS subset).
 *
 * Every hash anchored onchain (metadata hash, contract-metadata hash) is computed over this
 * canonical form, so any client can independently reproduce and verify it:
 *   keccak256(utf8(canonicalize(document)))
 *
 * Rules:
 *  - object keys sorted by UTF-16 code units (JS default string comparison, as JCS specifies)
 *  - no insignificant whitespace
 *  - numbers serialized via ECMAScript `JSON.stringify` semantics (JCS number formatting)
 *  - rejects: undefined, functions, symbols, BigInt, NaN/Infinity, and circular structures
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();

  const ser = (v: unknown): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new CanonicalizationError("non-finite number");
        return JSON.stringify(v);
      case "string":
        return JSON.stringify(v);
      case "bigint":
        throw new CanonicalizationError("BigInt is not JSON-serializable; use a string");
      case "undefined":
      case "function":
      case "symbol":
        throw new CanonicalizationError(`cannot canonicalize value of type ${typeof v}`);
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new CanonicalizationError("circular structure");
      seen.add(v);
      const out = `[${v.map((x) => ser(x === undefined ? null : x)).join(",")}]`;
      seen.delete(v);
      return out;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (seen.has(o)) throw new CanonicalizationError("circular structure");
      seen.add(o);
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      const out = `{${keys.map((k) => `${JSON.stringify(k)}:${ser(o[k])}`).join(",")}}`;
      seen.delete(o);
      return out;
    }
    throw new CanonicalizationError("unsupported value");
  };

  return ser(value);
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** UTF-8 bytes of the canonical form — the exact bytes hashed for BOTH the keccak anchor
 *  and the IPFS CID, so the two commitments always cover identical content. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** keccak256 hash of the canonical form of a JSON document. This is the onchain anchor value. */
export function hashDocument(value: unknown): Hex {
  return keccak256(canonicalBytes(value));
}

/** Verify a document against an anchored hash. */
export function verifyDocumentHash(value: unknown, anchoredHash: Hex): boolean {
  try {
    return hashDocument(value).toLowerCase() === anchoredHash.toLowerCase();
  } catch {
    return false;
  }
}
