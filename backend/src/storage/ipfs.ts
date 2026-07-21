import {computeCid, verifyCid} from "@actp/core";
import type {AppConfig} from "../config.js";

/**
 * Content-addressed document storage (ACTP offchain availability layer).
 *
 * Documents are stored as IPFS raw blocks (CIDv1, raw codec, sha2-256) so their address is
 * a hash of their content — retrievable from any node and self-verifying. The onchain keccak
 * anchor is unchanged; the CID is the availability + retrieval-integrity locator.
 *
 * Two implementations share one interface (same pattern as Postgres/PGlite and the
 * deterministic/LLM extractor): an in-memory store for dev/test (real CIDs, zero external
 * deps, fully offline) and a Kubo-RPC store for production self-hosted IPFS nodes.
 */
export interface IpfsStore {
  readonly kind: "memory" | "kubo";
  /** Store bytes, pin them, and return their CID. */
  put(bytes: Uint8Array): Promise<{cid: string}>;
  /** Fetch bytes by CID, or null if unavailable. Implementations MUST verify the returned
   *  bytes hash to the requested CID before returning them. */
  get(cid: string): Promise<Uint8Array | null>;
}

export function createIpfsStore(config: AppConfig): IpfsStore {
  return config.IPFS_MODE === "kubo" ? new KuboIpfsStore(config.IPFS_API_URL) : new MemoryIpfsStore();
}

/** In-memory store: computes real CIDs, keeps bytes in a Map. Dev/test only. */
export class MemoryIpfsStore implements IpfsStore {
  readonly kind = "memory" as const;
  private readonly blocks = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<{cid: string}> {
    const cid = await computeCid(bytes);
    this.blocks.set(cid, bytes);
    return {cid};
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const bytes = this.blocks.get(cid);
    if (!bytes) return null;
    // defense in depth: never return bytes that don't hash to the requested CID
    return (await verifyCid(bytes, cid)) ? bytes : null;
  }
}

/**
 * Kubo (go-ipfs) RPC store. Writes raw blocks via `/api/v0/block/put` with the raw codec and
 * sha2-256, pinned; reads via `/api/v0/block/get`. The CID Kubo returns is cross-checked
 * against a locally-computed CID so a node misconfiguration can never silently change the
 * address we anchor.
 */
export class KuboIpfsStore implements IpfsStore {
  readonly kind = "kubo" as const;
  constructor(private readonly apiUrl: string) {}

  async put(bytes: Uint8Array): Promise<{cid: string}> {
    const form = new FormData();
    form.append("data", new Blob([Buffer.from(bytes)]));
    const res = await fetch(`${this.apiUrl}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&pin=true`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`IPFS block put failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {Key: string};
    const expected = await computeCid(bytes);
    if (json.Key !== expected) {
      throw new Error(`IPFS returned unexpected CID ${json.Key}, expected ${expected}`);
    }
    return {cid: json.Key};
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const res = await fetch(`${this.apiUrl}/api/v0/block/get?arg=${encodeURIComponent(cid)}`, {
      method: "POST",
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // never trust the node: the CID is a content hash, so verify what it returned
    return (await verifyCid(bytes, cid)) ? bytes : null;
  }
}
