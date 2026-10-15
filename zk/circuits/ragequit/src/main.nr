//! ragequit: public exit back to the ORIGINAL DEPOSITOR (Privacy Pools model).
//!
//! If a deposit's label is excluded from the association set, its notes can no
//! longer be spent privately (transact/policy_pay require ASP membership). The
//! owner can still exit with this proof, but only PUBLICLY: amount, token and
//! label are revealed, and the contract sends the funds to depositorOf[label],
//! never to an address of the prover's choosing. Honest users are never trapped;
//! excluded funds can't hide in the crowd.
//!
//! STATEMENT: the prover owns (knows sk for) a note (amount, token, label) in
//! `root`, and `nullifier` is its nullifier (so it can't also be spent privately).
use shielded::{merkle_root, note_commitment, nullifier as nf, nullifier_key, owner_pk, NOTE_TREE_DEPTH};

fn main(
    root: pub Field,
    nullifier: pub Field,
    amount: pub u128,
    token: pub Field,
    label: pub Field,
    sk: Field,
    blinding: Field,
    policy: Field,
    leaf_index: Field,
    path: [Field; NOTE_TREE_DEPTH],
) {
    let cm = note_commitment(amount as Field, token, label, owner_pk(sk), blinding, policy);
    assert(merkle_root(cm, leaf_index, path) == root, "note not in tree");
    assert(nf(nullifier_key(sk), cm, leaf_index) == nullifier, "bad nullifier");
}

#[test(should_fail_with = "note not in tree")]
fn wrong_amount_fails() {
    // claiming more than the note holds changes the commitment -> not in the tree
    let sk = 0x1234;
    let cm = note_commitment(100, 0xa0b8, 77, owner_pk(sk), 7, 0);
    let mut zeros = [0; NOTE_TREE_DEPTH];
    let mut z = 0;
    for i in 0..NOTE_TREE_DEPTH {
        zeros[i] = z;
        z = shielded::h2(z, z);
    }
    let root = merkle_root(cm, 0, zeros);
    main(root, nf(nullifier_key(sk), cm, 0), 101, 0xa0b8, 77, sk, 7, 0, 0, zeros);
}
