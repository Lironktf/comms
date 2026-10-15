//! M0 exercise 2: depth-20 Merkle membership.
//!
//! Public:  root
//! Private: leaf, index, path (20 sibling hashes)
//! Statement: hashing leaf up the path, choosing left/right by the bits of index,
//! reproduces root. The verifier learns that SOME leaf of the tree is known, not which.
use shielded::{h2, merkle_root, NOTE_TREE_DEPTH};

fn main(root: pub Field, leaf: Field, index: Field, path: [Field; NOTE_TREE_DEPTH]) {
    assert(merkle_root(leaf, index, path) == root);
}

#[test]
fn leaf_zero_of_sparse_tree() {
    // Tree containing only leaf 123 at index 0; all other leaves are 0.
    let mut zeros = [0; NOTE_TREE_DEPTH];
    let mut z = 0;
    for i in 0..NOTE_TREE_DEPTH {
        zeros[i] = z;
        z = h2(z, z);
    }
    let root = merkle_root(123, 0, zeros);
    main(root, 123, 0, zeros);
}
