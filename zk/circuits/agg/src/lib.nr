//! Recursive aggregation of transact proofs (zk/docs/aggregation.md).
//!
//! Aggregates form a binary tree, and every circuit in it exposes ONE public input, a digest:
//!   aggregate_2  verifies 2 transact proofs;     digest = K(pi_0 || pi_1)       (12 fields each)
//!   aggregate_4  verifies 2 aggregate_2 proofs;  digest = K(d_left || d_right)
//!   aggregate_8  verifies 2 aggregate_4 proofs;  digest = K(d_left || d_right)
//! where K(x) = keccak256(32-byte big-endian words of x) mod p. The pool recomputes the same
//! tree from the payments in calldata, so every inner public input stays bound, while the EVM
//! verifier sees a single public input. Each level pins its children's verification key, so
//! only transact proofs can enter at the leaves and only this tree can be built above them.
//!
//! Why a tree and not one flat circuit: one recursive verification costs ~820k gates, so a flat
//! aggregate_8 is 6.5M gates (a 2^23 circuit), too big to prove on a small server, while every
//! node here is a 2^21 circuit (aggregation.md has the measurements).
//!
//! Proofs verified in-circuit must use bb's `noir-recursive` target (Poseidon2 transcript, ZK);
//! the tree's root is proven with `-t evm` for the onchain verifier. The constants below are
//! bb v5.2.1's, from barretenberg/noir/bb_proof_verification/src/lib.nr at tag v5.2.1:
//!   PROOF_TYPE_HONK_ZK = 6, RECURSIVE_ZK_PROOF_LENGTH = 450 + 8, ULTRA_VK_LENGTH_IN_FIELDS = 115
//! and match what bb 5.2.1 produces for transact and aggregate_2 (458 proof fields, 115 vk fields).

pub global PROOF_TYPE_HONK_ZK: u32 = 6;
pub global PROOF_LENGTH: u32 = 458;
pub global VK_LENGTH: u32 = 115;
pub global TRANSACT_PUBLIC_INPUTS: u32 = 12;

/// Recursion-target verification-key hashes (Poseidon2, as bb computes them; `bb write_vk
/// -t noir-recursive` writes them to vk_hash). bb's recursive verifier constrains
/// `key_hash == hash(vk)` in-circuit (ultra_honk/oink_verifier.cpp at v5.2.1:
/// `vk_and_hash->hash.assert_equal(vk_hash)`), so pinning the hash pins the child circuit.
/// scripts/build-aggregates.sh regenerates and checks them; any change to transact (or to a
/// lower level) changes every hash above it.
pub global TRANSACT_VK_HASH: Field = 0x288bb43edac5751ed2c3e3f77aceda051a791b3ced2ff4794ec9c2587b4cf4c2;
pub global AGGREGATE_2_VK_HASH: Field = 0x1e9682f2e96c5964dc318651bc39b1f5d612fd1c78b33bafda273c1e7287c704;
pub global AGGREGATE_4_VK_HASH: Field = 0x1dcf4c34da6f2d9a6538457ea4bbebe7b5e96c4133be54a6b64b2e21e9767e54;

/// Verifies one child proof whose verification key must hash to `pinned`.
pub fn verify_pinned<let K: u32>(
    vk: [Field; VK_LENGTH],
    key_hash: Field,
    pinned: Field,
    proof: [Field; PROOF_LENGTH],
    public_inputs: [Field; K],
) {
    assert(key_hash == pinned, "unexpected verification key");
    std::verify_proof_with_type(vk, proof, public_inputs, key_hash, PROOF_TYPE_HONK_ZK);
}

/// K(x) = keccak256(be32(x[0][0]) || ... || be32(x[N-1][M-1])) mod p.
/// Solidity: uint256(keccak256(abi.encodePacked(words))) % FIELD (ShieldedHashes.toField).
/// Keccak because the pool recomputes it: the EVM has it as an opcode (30 + 6 gas per word),
/// while Poseidon2 costs a contract call per permutation (aggregation.md).
pub fn digest<let N: u32, let M: u32>(x: [[Field; M]; N]) -> Field {
    let mut bytes: [u8; N * M * 32] = [0; N * M * 32];
    for i in 0..N {
        for j in 0..M {
            // canonical decomposition, so x and x + p cannot give different digests
            let b: [u8; 32] = x[i][j].to_be_bytes();
            for k in 0..32 {
                bytes[(i * M + j) * 32 + k] = b[k];
            }
        }
    }
    let h = keccak256(bytes);
    let mut acc: Field = 0;
    for k in 0..32 {
        acc = acc * 256 + h[k] as Field; // wraps mod p, like `% FIELD` on the uint256
    }
    acc
}

/// One tree node: verifies two children of the level below and returns K(d_left || d_right).
pub fn node(
    vk: [Field; VK_LENGTH],
    key_hash: Field,
    pinned: Field,
    proofs: [[Field; PROOF_LENGTH]; 2],
    child_digests: [Field; 2],
) -> Field {
    verify_pinned(vk, key_hash, pinned, proofs[0], [child_digests[0]]);
    verify_pinned(vk, key_hash, pinned, proofs[1], [child_digests[1]]);
    digest([child_digests])
}

global RATE: u32 = 136; // keccak256 rate in bytes (17 lanes)

/// Keccak-256 (the Ethereum variant: pad10*1 with 0x01 ... 0x80) over a fixed-length input,
/// built on the stdlib's keccakf1600 permutation. All indices are compile-time constants.
pub fn keccak256<let L: u32>(input: [u8; L]) -> [u8; 32] {
    let blocks = L / RATE + 1;
    let mut state: [u64; 25] = [0; 25];
    for b in 0..blocks {
        for lane in 0..17 {
            let mut v: u64 = 0;
            for k in 0..8 {
                let i = b * RATE + lane * 8 + k;
                let mut byte: u64 = 0;
                if i < L {
                    byte = input[i] as u64;
                } else if i == L {
                    byte = 0x01;
                }
                if i == blocks * RATE - 1 {
                    byte = byte | 0x80;
                }
                v = v + (byte << (8 * k) as u64);
            }
            state[lane] = state[lane] ^ v;
        }
        state = std::hash::keccakf1600(state);
    }
    let mut out: [u8; 32] = [0; 32];
    for lane in 0..4 {
        let v = state[lane];
        for k in 0..8 {
            out[lane * 8 + k] = ((v >> (8 * k) as u64) & 0xff) as u8;
        }
    }
    out
}

#[test]
fn keccak_empty() {
    // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    let h = keccak256([0 as u8; 0]);
    assert(h[0] == 0xc5);
    assert(h[1] == 0xd2);
    assert(h[31] == 0x70);
}

#[test]
fn keccak_two_blocks() {
    // keccak256(136 zero bytes): exactly one full block, so padding takes a second block
    // = 0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9 (cast keccak)
    let h = keccak256([0 as u8; 136]);
    assert(h[0] == 0x3a);
    assert(h[1] == 0x59);
    assert(h[31] == 0xf9);
}
