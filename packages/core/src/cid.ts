import {CID} from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import {sha256} from "multiformats/hashes/sha2";

/**
 * Content-addressed identifiers for ACTP offchain documents.
 *
 * We store documents as IPFS **raw blocks** (CIDv1, `raw` codec 0x55, sha2-256 multihash).
 * A CID computed this way is:
 *  - deterministic and reproducible offline (no IPFS node needed to derive it), and
 *  - self-verifying: the CID *is* a hash of the bytes, so a gateway cannot serve tampered
 *    content under the same address.
 *
 * This complements — does not replace — the onchain keccak256 anchor. The keccak hash is the
 * cheap onchain equality commitment (over canonical JSON); the CID is the availability +
 * retrieval-integrity locator. A consumer checks both: keccak == onchain anchor (the vendor
 * committed to this doc) AND cid matches (this is the doc at that address).
 */

/** Compute the CIDv1 (raw, sha2-256) for a byte string. */
export async function computeCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, raw.code, digest).toString();
}

/** True iff `bytes` hashes to `cidStr` under the raw/sha2-256 scheme. */
export async function verifyCid(bytes: Uint8Array, cidStr: string): Promise<boolean> {
  try {
    const expected = CID.parse(cidStr);
    const digest = await sha256.digest(bytes);
    const actual = CID.create(1, raw.code, digest);
    return actual.equals(expected);
  } catch {
    return false;
  }
}

export function isValidCid(cidStr: string): boolean {
  try {
    CID.parse(cidStr);
    return true;
  } catch {
    return false;
  }
}

/** Parse `ipfs://<cid>` or a bare CID; returns the CID string or null. */
export function parseIpfsUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const cid = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri;
  return isValidCid(cid) ? cid : null;
}

export function toIpfsUri(cid: string): string {
  return `ipfs://${cid}`;
}
