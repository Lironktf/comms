//! aggregate_4: verifies 2 aggregate_2 proofs (4 payments); public input K(d_left || d_right).
use agg::{node, AGGREGATE_2_VK_HASH, PROOF_LENGTH, VK_LENGTH};

fn main(
    vk: [Field; VK_LENGTH],
    key_hash: Field,
    proofs: [[Field; PROOF_LENGTH]; 2],
    child_digests: [Field; 2],
    payments_digest: pub Field,
) {
    assert(node(vk, key_hash, AGGREGATE_2_VK_HASH, proofs, child_digests) == payments_digest, "digest mismatch");
}
