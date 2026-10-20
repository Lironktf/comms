//! aggregate_8: verifies 2 aggregate_4 proofs (8 payments); public input K(d_left || d_right).
use agg::{node, AGGREGATE_4_VK_HASH, PROOF_LENGTH, VK_LENGTH};

fn main(
    vk: [Field; VK_LENGTH],
    key_hash: Field,
    proofs: [[Field; PROOF_LENGTH]; 2],
    child_digests: [Field; 2],
    payments_digest: pub Field,
) {
    assert(node(vk, key_hash, AGGREGATE_4_VK_HASH, proofs, child_digests) == payments_digest, "digest mismatch");
}
