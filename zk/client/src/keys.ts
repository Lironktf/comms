import {hkdf} from "@noble/hashes/hkdf.js";
import {sha256} from "@noble/hashes/sha2.js";
import {x25519} from "@noble/curves/ed25519.js";
import {adminPk, nullifierKey, ownerPk} from "./hashes.js";
import {bigintToBytes, bytesToBigint, P, toHex32} from "./field.js";

/**
 * Key hierarchy (Zcash-inspired, simplified). Everything derives from ONE 32-byte seed, so
 * one backup recovers every note (notes are found again by trial-decrypting pool events).
 *
 *   seed ──HKDF──► sk (spending key, a field element)
 *                   ├─► nk    = H3(NK, sk, 0)     nullifier key: lets a watcher see spends
 *                   └─► owner = H3(OWNER, sk, 0)  public: goes inside notes you receive
 *        ──HKDF──► viewing key (X25519)           decrypts incoming note ciphertexts
 *        ──HKDF──► adminSk                        controls policies of your agents
 *
 * Agents get their OWN sk / viewing key, derived from the human's seed with an agent index,
 * so the human can always recover (and, as policy admin, sweep) agent funds.
 */
export interface SpendingKeys {
  sk: bigint;
  nk: bigint;
  owner: bigint;
  viewingPriv: Uint8Array;
  viewingPub: Uint8Array;
}

export interface AdminKeys {
  adminSk: bigint;
  adminPk: bigint;
}

function deriveField(seed: Uint8Array, info: string): bigint {
  // 64 bytes of output reduced mod P: statistically uniform field element.
  return bytesToBigint(hkdf(sha256, seed, new Uint8Array(0), new TextEncoder().encode(info), 64)) % P;
}

function deriveBytes(seed: Uint8Array, info: string, len: number): Uint8Array {
  return hkdf(sha256, seed, new Uint8Array(0), new TextEncoder().encode(info), len);
}

export function spendingKeysFromSk(sk: bigint, viewingPriv: Uint8Array): SpendingKeys {
  return {sk, nk: nullifierKey(sk), owner: ownerPk(sk), viewingPriv, viewingPub: x25519.getPublicKey(viewingPriv)};
}

/** Account keys (account 0 = the human's own wallet). */
export function deriveSpendingKeys(seed: Uint8Array, account = 0): SpendingKeys {
  if (seed.length < 32) throw new Error("seed must be >= 32 bytes");
  const sk = deriveField(seed, `grayr.zk.v1.sk.${account}`);
  return spendingKeysFromSk(sk, deriveBytes(seed, `grayr.zk.v1.view.${account}`, 32));
}

/** Agent sub-account keys: what you hand to an agent (never your own seed). */
export function deriveAgentKeys(seed: Uint8Array, agentIndex: number): SpendingKeys {
  return deriveSpendingKeys(seed, 1_000_000 + agentIndex);
}

export function deriveAdminKeys(seed: Uint8Array): AdminKeys {
  const adminSk = deriveField(seed, "grayr.zk.v1.admin");
  return {adminSk, adminPk: adminPk(adminSk)};
}

/** Shareable payment address: owner public key + X25519 viewing public key. */
export interface ShieldedAddress {
  owner: bigint;
  viewingPub: Uint8Array;
}

export function encodeAddress(a: ShieldedAddress): string {
  return `zk1${toHex32(a.owner).slice(2)}${Buffer.from(a.viewingPub).toString("hex")}`;
}

export function decodeAddress(s: string): ShieldedAddress {
  if (!/^zk1[0-9a-f]{128}$/.test(s)) throw new Error("bad shielded address");
  const owner = BigInt("0x" + s.slice(3, 67));
  if (owner >= P) throw new Error("bad shielded address");
  return {owner, viewingPub: Uint8Array.from(Buffer.from(s.slice(67), "hex"))};
}

export const addressOf = (k: SpendingKeys): ShieldedAddress => ({owner: k.owner, viewingPub: k.viewingPub});

export {bigintToBytes};
