import {chacha20poly1305} from "@noble/ciphers/chacha.js";
import {x25519} from "@noble/curves/ed25519.js";
import {hkdf} from "@noble/hashes/hkdf.js";
import {sha256} from "@noble/hashes/sha2.js";
import {budgetCommitment, noteCommitment, noteCore, noteInner} from "./hashes.js";
import {bigintToBytes, bytesToBigint, randomField} from "./field.js";
import type {ShieldedAddress, SpendingKeys} from "./keys.js";

/** A value note. Lives only on the owner's machine; the chain stores H(note). */
export interface Note {
  kind: "note";
  amount: bigint;
  token: bigint; // ERC-20 address as a field element
  label: bigint; // deposit lineage tag (association sets + ragequit)
  owner: bigint;
  blinding: bigint;
  policy: bigint; // 0 = no spending policy
}

/** A budget note: remaining allowance of an agent policy for one period. */
export interface BudgetNote {
  kind: "budget";
  remaining: bigint;
  period: bigint;
  owner: bigint;
  blinding: bigint;
  policy: bigint;
}

export type AnyNote = Note | BudgetNote;

export function commitmentOf(n: AnyNote): bigint {
  return n.kind === "note" ? noteCommitment(n) : budgetCommitment(n);
}

export function newNote(p: Omit<Note, "kind" | "blinding"> & {blinding?: bigint}): Note {
  return {kind: "note", ...p, blinding: p.blinding ?? randomField()};
}

// ---------------------------------------------------------------------------
// Encryption: ECIES-style, X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
// ciphertext = ephemeralPub(32) || AEAD(key, nonce=0, plaintext)
// The key is unique per (ephemeral, recipient) so a fixed nonce is safe.
// The OWNER field is not encrypted: the recipient knows its own owner key, and a decrypted
// note is only accepted if it recomputes the onchain commitment under that owner.
// ---------------------------------------------------------------------------

const INFO = new TextEncoder().encode("grayr.zk.v1.note-encryption");
const NONCE = new Uint8Array(12);

function serialize(n: AnyNote): Uint8Array {
  if (n.kind === "note") {
    return concat([
      Uint8Array.of(0),
      bigintToBytes(n.amount, 16),
      bigintToBytes(n.token, 20),
      bigintToBytes(n.label, 32),
      bigintToBytes(n.blinding, 32),
      bigintToBytes(n.policy, 32),
    ]);
  }
  return concat([
    Uint8Array.of(1),
    bigintToBytes(n.remaining, 16),
    bigintToBytes(n.period, 8),
    bigintToBytes(n.blinding, 32),
    bigintToBytes(n.policy, 32),
  ]);
}

function deserialize(b: Uint8Array, owner: bigint): AnyNote | null {
  const r = (o: number, l: number) => bytesToBigint(b.subarray(o, o + l));
  if (b[0] === 0 && b.length === 133) {
    return {kind: "note", amount: r(1, 16), token: r(17, 20), label: r(37, 32), blinding: r(69, 32), policy: r(101, 32), owner};
  }
  if (b[0] === 1 && b.length === 89) {
    return {kind: "budget", remaining: r(1, 16), period: r(17, 8), blinding: r(25, 32), policy: r(57, 32), owner};
  }
  return null;
}

export function encryptNote(n: AnyNote, to: ShieldedAddress): Uint8Array {
  if (n.owner !== to.owner) throw new Error("note owner does not match recipient address");
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = hkdf(sha256, x25519.getSharedSecret(eph, to.viewingPub), ephPub, INFO, 32);
  return concat([ephPub, chacha20poly1305(key, NONCE).encrypt(serialize(n))]);
}

/**
 * Fields only the CHAIN knows, filled in before the commitment check:
 *  - label: a deposit's label is assigned onchain, so a deposit ciphertext carries label 0.
 *  - amount/token: deferred outputs (swap output, Path-B refund) get their amount onchain.
 */
export interface DecryptHints {
  label?: bigint;
  amount?: bigint;
  token?: bigint;
}

/** Try to decrypt with our viewing key; returns the note only if it matches `commitment`
 *  (so a garbage or malicious ciphertext can never make us believe in a note that isn't real). */
export function tryDecryptNote(ct: Uint8Array, keys: SpendingKeys, commitment: bigint, hints: DecryptHints = {}): AnyNote | null {
  if (ct.length < 32 + 16) return null;
  try {
    const ephPub = ct.subarray(0, 32);
    const key = hkdf(sha256, x25519.getSharedSecret(keys.viewingPriv, ephPub), ephPub, INFO, 32);
    const note = deserialize(chacha20poly1305(key, NONCE).decrypt(ct.subarray(32)), keys.owner);
    if (!note) return null;
    if (note.kind === "note") {
      if (note.label === 0n && hints.label !== undefined) note.label = hints.label;
      if (note.amount === 0n && hints.amount !== undefined) note.amount = hints.amount;
      if (hints.token !== undefined && hints.amount !== undefined) note.token = hints.token;
    }
    if (commitmentOf(note) !== commitment) return null;
    return note;
  } catch {
    return null;
  }
}

/** Decrypt a refund-slot ciphertext and check it opens the given note CORE (its amount and
 *  token are only fixed if and when a refund happens). Used to recognise our own payments. */
export function tryDecryptCore(ct: Uint8Array, keys: SpendingKeys, core: bigint): Note | null {
  if (ct.length < 32 + 16) return null;
  try {
    const ephPub = ct.subarray(0, 32);
    const key = hkdf(sha256, x25519.getSharedSecret(keys.viewingPriv, ephPub), ephPub, INFO, 32);
    const note = deserialize(chacha20poly1305(key, NONCE).decrypt(ct.subarray(32)), keys.owner);
    if (!note || note.kind !== "note") return null;
    return noteCore(note.label, noteInner(note.owner, note.blinding, note.policy)) === core ? note : null;
  } catch {
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
