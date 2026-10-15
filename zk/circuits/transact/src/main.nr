//! transact: the general 2-in / 2-out spend.
//!
//! Covers private transfer (public_amount = 0), pay-a-merchant / withdraw
//! (public_amount > 0 to `recipient`), Path-B authorization and swaps (deferred mode).
//!
//! STATEMENT (what a valid proof convinces the verifier of):
//!   1. Ownership: the prover knows `sk` such that owner_pk(sk) is the owner of both input notes.
//!   2. Existence: every input note with nonzero amount is a leaf of the tree with root `root`.
//!   3. Nullifiers: nullifiers[i] = H(nk(sk), commitment_i, leafIndex_i), distinct.
//!   4. Conservation: in0 + in1 == out0 + out1' + public_amount + fee, where
//!      out1' = out1 normally, and 0 in deferred mode (see below). All amounts are u128.
//!   5. Lineage/compliance: every note in this tx carries the same deposit `label`,
//!      and `label` is in the association set with root `asp_root`.
//!   6. Policy notes (policy != 0) can only be spent here with the policy ADMIN key.
//!      (Agents spend policy notes through policy_pay, which enforces the policy.)
//!   7. out_commitments are well-formed notes of `token`, inheriting `label`.
//!
//! The proof reveals NOTHING about: which leaves were spent, amounts of inputs/outputs,
//! owners, blinding factors, the label, or the policy.
//!
//! `recipient` and `context` are not used by any constraint below; they are public
//! inputs purely so the proof is bound to them (the verifier rejects the proof if
//! either changes; see the negative tests in zk/contracts/test). `context` is a hash
//! the CONTRACT computes over (chainId, pool, feeRecipient, x402 requestId, deadline,
//! encrypted outputs), so a proof can't be replayed on another chain/pool, redirected
//! to another relayer, or re-attached to another x402 request.
//!
//! DEFERRED MODE (deferred = true): out_commitments[1] is the note CORE
//! H3(NOTE, label, inner) instead of a full commitment, and out1 is excluded from
//! conservation. The contract "materializes" it later as H3(amount, token, core) with
//! an amount/token it knows: the refund of an unused Path-B authorization
//! (amount = public_amount), or the output of a private swap (amount = tokens received).
use shielded::{
    h3, merkle_root, note_commitment, note_core, note_inner, nullifier, nullifier_key, owner_pk,
    admin_pk, Policy, ASP_TREE_DEPTH, NOTE_TREE_DEPTH,
};

fn main(
    // ----------------------------- public -----------------------------
    root: pub Field,
    asp_root: pub Field,
    nullifiers: pub [Field; 2],
    out_commitments: pub [Field; 2],
    public_amount: pub u128,
    fee: pub u128,
    token: pub Field,
    recipient: pub Field,
    deferred: pub bool,
    context: pub Field,
    // ----------------------------- private ----------------------------
    sk: Field,
    label: Field,
    asp_index: Field,
    asp_path: [Field; ASP_TREE_DEPTH],
    policy: Field,
    policy_params: Policy,
    admin_sk: Field,
    in_amounts: [u128; 2],
    in_blindings: [Field; 2],
    in_indices: [Field; 2],
    in_paths: [[Field; NOTE_TREE_DEPTH]; 2],
    out_amounts: [u128; 2],
    out_owners: [Field; 2],
    out_blindings: [Field; 2],
    out_policies: [Field; 2],
) {
    let _ = (recipient, context); // bound as public inputs only (see header)

    let owner = owner_pk(sk);
    let nk = nullifier_key(sk);

    // (6) Policy-bound notes need the admin. Without this, an agent holding `sk` could
    // bypass its spending policy by using this circuit instead of policy_pay.
    if policy != 0 {
        assert(policy_params.hash() == policy, "policy preimage mismatch");
        assert(admin_pk(admin_sk) == policy_params.admin_pk, "not the policy admin");
    }

    // (1)-(3) inputs
    let mut sum_in: Field = 0;
    for i in 0..2 {
        let cm = note_commitment(in_amounts[i] as Field, token, label, owner, in_blindings[i], policy);
        // Zero-value inputs are "dummies" (so a 1-input spend still fits 2-in-2-out);
        // they create no value, so they need not exist in the tree.
        if in_amounts[i] != 0 {
            assert(merkle_root(cm, in_indices[i], in_paths[i]) == root, "input not in tree");
        }
        assert(nullifier(nk, cm, in_indices[i]) == nullifiers[i], "bad nullifier");
        sum_in += in_amounts[i] as Field;
    }
    assert(nullifiers[0] != nullifiers[1], "duplicate nullifier");

    // (5) the shared deposit label is in the association set
    assert(merkle_root(label, asp_index, asp_path) == asp_root, "label not in association set");

    // (7) outputs
    let cm0 = note_commitment(
        out_amounts[0] as Field,
        token,
        label,
        out_owners[0],
        out_blindings[0],
        out_policies[0],
    );
    assert(cm0 == out_commitments[0], "bad output 0");

    let mut sum_out: Field = out_amounts[0] as Field;
    if deferred {
        let core1 = note_core(label, note_inner(out_owners[1], out_blindings[1], out_policies[1]));
        assert(core1 == out_commitments[1], "bad deferred core");
        assert(out_amounts[1] == 0, "deferred output amount is set on-chain");
    } else {
        let cm1 = note_commitment(
            out_amounts[1] as Field,
            token,
            label,
            out_owners[1],
            out_blindings[1],
            out_policies[1],
        );
        assert(cm1 == out_commitments[1], "bad output 1");
        sum_out += out_amounts[1] as Field;
    }

    // (4) exact conservation. Each term is a range-checked u128, so the Field sums
    // (< 2^131) can't wrap around the ~2^254 field modulus.
    assert(sum_in == sum_out + public_amount as Field + fee as Field, "value not conserved");
}

// ---------------------------------------------------------------------------
// Circuit-level tests (run with `nargo test --package transact`).
// The exhaustive negative tests (tampered public inputs, stale roots, replay...)
// live in zk/contracts/test and zk/client/test, against real proofs.
// ---------------------------------------------------------------------------

#[test]
fn transfer_and_pay_ok() {
    let t = test_setup();
    main(
        t.root, t.asp_root, t.nfs, t.outs, 30, 2, t.token, 0xabc, false, 0x55,
        t.sk, t.label, 0, t.asp_path, 0, t.no_policy, 0,
        [100, 0], [7, 8], [0, 1], [t.path0, t.path1],
        [60, 8], [t.owner, 0x42], [11, 12], [0, 0],
    );
}

#[test(should_fail_with = "value not conserved")]
fn overspend_fails() {
    let t = test_setup();
    main(
        t.root, t.asp_root, t.nfs, t.outs_overspend, 30, 2, t.token, 0xabc, false, 0x55,
        t.sk, t.label, 0, t.asp_path, 0, t.no_policy, 0,
        [100, 0], [7, 8], [0, 1], [t.path0, t.path1],
        [61, 8], [t.owner, 0x42], [11, 12], [0, 0],
    );
}

#[test(should_fail_with = "input not in tree")]
fn wrong_secret_fails() {
    let t = test_setup();
    // a different sk => different owner => commitment not in the tree
    main(
        t.root, t.asp_root, t.nfs, t.outs, 30, 2, t.token, 0xabc, false, 0x55,
        t.sk + 1, t.label, 0, t.asp_path, 0, t.no_policy, 0,
        [100, 0], [7, 8], [0, 1], [t.path0, t.path1],
        [60, 8], [t.owner, 0x42], [11, 12], [0, 0],
    );
}

#[test(should_fail_with = "label not in association set")]
fn unapproved_label_fails() {
    let t = test_setup();
    main(
        t.root, t.asp_root + 1, t.nfs, t.outs, 30, 2, t.token, 0xabc, false, 0x55,
        t.sk, t.label, 0, t.asp_path, 0, t.no_policy, 0,
        [100, 0], [7, 8], [0, 1], [t.path0, t.path1],
        [60, 8], [t.owner, 0x42], [11, 12], [0, 0],
    );
}

struct TestSetup {
    sk: Field,
    owner: Field,
    token: Field,
    label: Field,
    root: Field,
    asp_root: Field,
    asp_path: [Field; ASP_TREE_DEPTH],
    path0: [Field; NOTE_TREE_DEPTH],
    path1: [Field; NOTE_TREE_DEPTH],
    nfs: [Field; 2],
    outs: [Field; 2],
    outs_overspend: [Field; 2],
    no_policy: Policy,
}

fn test_setup() -> TestSetup {
    let sk = 0x1234;
    let owner = owner_pk(sk);
    let nk = nullifier_key(sk);
    let token = 0xa0b8;
    let label = 0x77;
    // tree: leaf0 = a 100-unit note, everything else empty
    let cm0 = note_commitment(100, token, label, owner, 7, 0);
    let mut zeros = [0; NOTE_TREE_DEPTH];
    let mut z = 0;
    for i in 0..NOTE_TREE_DEPTH {
        zeros[i] = z;
        z = shielded::h2(z, z);
    }
    let root = merkle_root(cm0, 0, zeros);
    let asp_root = merkle_root(label, 0, zeros);
    let dummy = note_commitment(0, token, label, owner, 8, 0);
    let _ = h3(0, 0, 0);
    TestSetup {
        sk,
        owner,
        token,
        label,
        root,
        asp_root,
        asp_path: zeros,
        path0: zeros,
        path1: zeros,
        nfs: [nullifier(nk, cm0, 0), nullifier(nk, dummy, 1)],
        outs: [note_commitment(60, token, label, owner, 11, 0), note_commitment(8, token, label, 0x42, 12, 0)],
        outs_overspend: [
            note_commitment(61, token, label, owner, 11, 0),
            note_commitment(8, token, label, 0x42, 12, 0),
        ],
        no_policy: Policy {
            admin_pk: 0,
            token: 0,
            max_per_payment: 0,
            max_fee: 0,
            period_budget: 0,
            period_seconds: 0,
            min_vendor_level: 0,
            category_mask: 0,
            require_verified_vendor: false,
        },
    }
}
