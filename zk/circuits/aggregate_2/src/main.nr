//! aggregate_2: verifies 2 transact proofs; the one public input is K(pi_0 || pi_1) (see agg).
use agg::{digest, verify_pinned, PROOF_LENGTH, TRANSACT_PUBLIC_INPUTS, TRANSACT_VK_HASH, VK_LENGTH};

fn main(
    vk: [Field; VK_LENGTH],
    key_hash: Field,
    proofs: [[Field; PROOF_LENGTH]; 2],
    public_inputs: [[Field; TRANSACT_PUBLIC_INPUTS]; 2],
    payments_digest: pub Field,
) {
    for i in 0..2 {
        verify_pinned(vk, key_hash, TRANSACT_VK_HASH, proofs[i], public_inputs[i]);
    }
    assert(digest(public_inputs) == payments_digest, "digest mismatch");
}
