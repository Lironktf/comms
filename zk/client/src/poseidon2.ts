import {INTERNAL_DIAG, ROUND_CONSTANTS} from "./poseidon2-constants.js";

/** BN254 scalar field modulus (the field every Noir `Field` lives in). */
export const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

const mod = (x: bigint) => ((x % P) + P) % P;
const pow5 = (x: bigint) => {
  const x2 = (x * x) % P;
  return (((x2 * x2) % P) * x) % P;
};

function externalMatrix(s: bigint[]): void {
  // The 4x4 MDS matrix from the Poseidon2 paper, in the addition-chain form used by
  // Barretenberg: [5 7 1 3; 4 6 1 1; 1 3 5 7; 1 1 4 6].
  const t0 = s[0]! + s[1]!;
  const t1 = s[2]! + s[3]!;
  const t2 = 2n * s[1]! + t1;
  const t3 = 2n * s[3]! + t0;
  const t4 = 4n * t1 + t3;
  const t5 = 4n * t0 + t2;
  const t6 = t3 + t5;
  const t7 = t2 + t4;
  s[0] = mod(t6);
  s[1] = mod(t5);
  s[2] = mod(t7);
  s[3] = mod(t4);
}

function internalMatrix(s: bigint[]): void {
  const sum = s[0]! + s[1]! + s[2]! + s[3]!;
  for (let i = 0; i < 4; i++) s[i] = mod(s[i]! * INTERNAL_DIAG[i]! + sum);
}

/** The Poseidon2 permutation on a width-4 state (8 full rounds, 56 partial rounds). */
export function permute(input: readonly bigint[]): bigint[] {
  if (input.length !== 4) throw new Error("poseidon2: state width is 4");
  const s = input.map(mod);
  externalMatrix(s);
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 4; i++) s[i] = pow5(mod(s[i]! + ROUND_CONSTANTS[r]![i]!));
    externalMatrix(s);
  }
  for (let r = 4; r < 60; r++) {
    s[0] = pow5(mod(s[0]! + ROUND_CONSTANTS[r]![0]!));
    internalMatrix(s);
  }
  for (let r = 60; r < 64; r++) {
    for (let i = 0; i < 4; i++) s[i] = pow5(mod(s[i]! + ROUND_CONSTANTS[r]![i]!));
    externalMatrix(s);
  }
  return s;
}

const TWO_64 = 1n << 64n;

/**
 * Poseidon2 sponge hash of 1-3 field elements, identical to noir-lang/poseidon's
 * `Poseidon2::hash(input, n)` and poseidon2-evm's `hash_n`: ONE permutation of
 * [a, b, c, n << 64], output word 0. The protocol never hashes more than 3 inputs.
 */
export function poseidon2(inputs: readonly bigint[]): bigint {
  const n = inputs.length;
  if (n < 1 || n > 3) throw new Error("poseidon2: protocol hashes take 1-3 inputs");
  const state = [0n, 0n, 0n, BigInt(n) * TWO_64];
  inputs.forEach((x, i) => (state[i] = mod(x)));
  return permute(state)[0]!;
}
