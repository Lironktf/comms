//! Shared primitives for the Grayr shielded pool.
//!
//! EVERY hash in the protocol is defined here, once. The Solidity contracts
//! (zk/contracts/src/libraries/ShieldedHashes.sol) and the TypeScript client
//! (zk/client/src/hashes.ts) re-implement exactly these definitions, and the
//! shared test vectors in zk/test-vectors/vectors.json prove all three agree.
//!
//! Hash function: Poseidon2 over BN254 (t=4, rate 3, Rf=8, Rp=56), as implemented
//! by noir-lang/poseidon v0.4.0. We only ever hash 2 or 3 field elements, so every
//! hash is exactly ONE permutation of the state [a, b, c, n << 64] (n = arity),
//! and we output state[0]. That restriction is deliberate: the on-chain Yul
//! implementation (poseidon2-evm) only exposes single-permutation hashes, and it
//! keeps on-chain gas at ~1 permutation per hash.
//!
//! Domain separation: objects with different meaning are hashed with a distinct
//! small-integer TAG in the first slot (see `tags`). Merkle nodes are the only
//! untagged arity-2 hash.

use poseidon::poseidon2::Poseidon2;

pub mod tags {
    pub global NK: Field = 1; // nullifier key   nk     = H3(NK, sk, 0)
    pub global OWNER: Field = 2; // owner public key owner  = H3(OWNER, sk, 0)
    pub global NOTE: Field = 3; // note core        core   = H3(NOTE, label, inner)
    pub global NULL: Field = 4; // nullifier        nf     = H3(NULL, nk, H2(cm, leafIndex))
    pub global BUDGET: Field = 5; // budget core    bcore  = H3(BUDGET, 0, inner)
    pub global POLICY: Field = 6; // policy hash
    pub global ADMIN: Field = 7; // admin public key adminPk = H3(ADMIN, adminSk, 0)
    pub global VENDOR: Field = 8; // verified-vendor leaf
}

/// Depth of the note-commitment tree (2^20 = 1,048,576 leaves).
pub global NOTE_TREE_DEPTH: u32 = 20;
/// Depth of the association-set (ASP) tree of approved deposit labels.
pub global ASP_TREE_DEPTH: u32 = 20;
/// Depth of the Grayr verified-vendor tree.
pub global VENDOR_TREE_DEPTH: u32 = 20;

pub fn h2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

pub fn h3(a: Field, b: Field, c: Field) -> Field {
    Poseidon2::hash([a, b, c], 3)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// Nullifier key. Derived from the spending key; can be handed to a watch-only
/// service so it can detect when your notes are spent, without being able to spend.
pub fn nullifier_key(sk: Field) -> Field {
    h3(tags::NK, sk, 0)
}

/// Owner public key. This is what a payer puts in a note to make it yours.
pub fn owner_pk(sk: Field) -> Field {
    h3(tags::OWNER, sk, 0)
}

/// Public key of a policy administrator (the human who controls an agent's policy).
pub fn admin_pk(admin_sk: Field) -> Field {
    h3(tags::ADMIN, admin_sk, 0)
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/// The private part of a note. At deposit time the user sends ONLY this to the
/// contract, so the chain never learns owner, blinding or policy.
pub fn note_inner(owner: Field, blinding: Field, policy: Field) -> Field {
    h3(owner, blinding, policy)
}

/// Label-bound core of a note. Swaps and Path-B refunds make the contract
/// "materialize" a note from a core plus an amount/token known only later.
pub fn note_core(label: Field, inner: Field) -> Field {
    h3(tags::NOTE, label, inner)
}

/// commitment = H3(amount, token, H3(NOTE, label, H3(owner, blinding, policy)))
pub fn note_commitment(
    amount: Field,
    token: Field,
    label: Field,
    owner: Field,
    blinding: Field,
    policy: Field,
) -> Field {
    h3(amount, token, note_core(label, note_inner(owner, blinding, policy)))
}

/// Budget note: remaining spend allowance for `period`, bound to an owner and a policy.
/// bcommit = H3(remaining, period, H3(BUDGET, 0, H3(owner, blinding, policy)))
pub fn budget_commitment(
    remaining: Field,
    period: Field,
    owner: Field,
    blinding: Field,
    policy: Field,
) -> Field {
    h3(remaining, period, h3(tags::BUDGET, 0, note_inner(owner, blinding, policy)))
}

/// Nullifier for the note at `leaf_index` with commitment `cm`.
/// Including the leaf index means two identical commitments inserted at different
/// positions (e.g. two deposits) are BOTH spendable (no "faerie gold").
pub fn nullifier(nk: Field, cm: Field, leaf_index: Field) -> Field {
    h3(tags::NULL, nk, h2(cm, leaf_index))
}

// ---------------------------------------------------------------------------
// Policy + vendors
// ---------------------------------------------------------------------------

pub struct Policy {
    pub admin_pk: Field,
    pub token: Field,
    pub max_per_payment: u128,
    pub max_fee: u128,
    pub period_budget: u128,
    pub period_seconds: u64,
    pub min_vendor_level: u8,
    /// Bitmask of allowed merchant categories. 0 = no category restriction.
    pub category_mask: u64,
    /// true: the agent may only pay Grayr-verified vendors (level + category checks apply).
    /// false: any recipient; caps and budget still apply. Revealed as the public input
    /// `vendor_checked` of policy_pay (the contract must know whether to live-check the vendor).
    pub require_verified_vendor: bool,
}

impl Policy {
    pub fn hash(self) -> Field {
        h3(
            tags::POLICY,
            h3(self.admin_pk, self.token, self.max_per_payment as Field),
            h3(
                h3(self.max_fee as Field, self.period_budget as Field, self.period_seconds as Field),
                h3(
                    self.min_vendor_level as Field,
                    self.category_mask as Field,
                    self.require_verified_vendor as Field,
                ),
                0,
            ),
        )
    }
}

/// Leaf of the verified-vendor tree, inserted by VendorTree.sol from live
/// AttestationRegistry state: wallet, verification level (0-5), category bitmask, expiry.
pub fn vendor_leaf(wallet: Field, level: Field, categories: Field, expiry: Field) -> Field {
    h3(tags::VENDOR, wallet, h3(level, categories, expiry))
}

// ---------------------------------------------------------------------------
// Merkle trees
// ---------------------------------------------------------------------------

/// Root of a binary Merkle tree given a leaf, its index and the sibling path.
/// `index.to_le_bits()` is a CONSTRAINED decomposition: it also proves index < 2^N,
/// so a prover can't use an out-of-range index to alias a different position.
pub fn merkle_root<let N: u32>(leaf: Field, index: Field, path: [Field; N]) -> Field {
    let bits: [bool; N] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..N {
        let sibling = path[i];
        // bit = 0 -> node is the LEFT child; bit = 1 -> node is the RIGHT child.
        let (l, r) = if bits[i] { (sibling, node) } else { (node, sibling) };
        node = h2(l, r);
    }
    node
}

/// Root of the empty tree of depth N (all leaves = 0).
pub fn empty_root<let N: u32>() -> Field {
    let mut z = 0;
    for _ in 0..N {
        z = h2(z, z);
    }
    z
}

// ---------------------------------------------------------------------------
// Tests / shared vectors
// ---------------------------------------------------------------------------

#[test]
fn poseidon2_matches_published_vector() {
    // Same vector as poseidon2-evm's test suite: hash_2(0, 0).
    assert(h2(0, 0) == 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1);
}

#[test]
fn merkle_index_bits() {
    let path = [11, 22, 33];
    // index 5 = 0b101: right, left, right
    let expect = h2(33, h2(h2(11, 7), 22));
    assert(merkle_root(7, 5, path) == expect);
}

#[test(should_fail)]
fn merkle_index_out_of_range_fails() {
    let _ = merkle_root(7, 8, [1, 2, 3]);
}

/// Prints the shared test vectors consumed by Solidity + TypeScript tests.
/// Run: nargo test --package shielded --show-output print_vectors
#[test]
fn print_vectors() {
    let sk = 0x1234;
    let owner = owner_pk(sk);
    let nk = nullifier_key(sk);
    let cm = note_commitment(5000000, 0xa0b86991, 77, owner, 999, 0);
    let a = h2(1, 2);
    let b = h3(1, 2, 3);
    let inner = note_inner(owner, 999, 0);
    let nf = nullifier(nk, cm, 3);
    let er = empty_root::<20>();
    let vl = vendor_leaf(0xbeef, 3, 5, 1800000000);
    let bc = budget_commitment(1000, 20000, owner, 555, 0x77);
    let pol = Policy {
        admin_pk: admin_pk(0x99),
        token: 0xa0b86991,
        max_per_payment: 10000000,
        max_fee: 50000,
        period_budget: 500000000,
        period_seconds: 2592000,
        min_vendor_level: 2,
        category_mask: 6,
        require_verified_vendor: true,
    }
        .hash();
    println(f"h2_1_2={a}");
    println(f"h3_1_2_3={b}");
    println(f"owner={owner}");
    println(f"nk={nk}");
    println(f"inner={inner}");
    println(f"commitment={cm}");
    println(f"nullifier={nf}");
    println(f"empty_root_20={er}");
    println(f"vendor_leaf={vl}");
    println(f"budget_commitment={bc}");
    println(f"policy={pol}");
}
