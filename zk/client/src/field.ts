import {P} from "./poseidon2.js";

export {P};

/** 0x-prefixed, 32-byte, lowercase hex of a field element / uint256. */
export const toHex32 = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(64, "0")}`;

export const fromHex = (h: string): bigint => BigInt(h);

/** Uniform random field element: 64 random bytes reduced mod P (bias < 2^-250). */
export function randomField(): bigint {
  const b = new Uint8Array(64);
  crypto.getRandomValues(b);
  return bytesToBigint(b) % P;
}

export function bytesToBigint(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

export function bigintToBytes(x: bigint, len: number): Uint8Array {
  if (x < 0n || x >= 1n << BigInt(8 * len)) throw new Error(`value does not fit in ${len} bytes`);
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export const addressToField = (a: string): bigint => BigInt(a);
export const fieldToAddress = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(40, "0")}`;
