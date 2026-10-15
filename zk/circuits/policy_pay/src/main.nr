//! policy_pay: an AGENT pays a merchant from policy-bound notes, with the
//! spending policy enforced inside the proof.
//!
//! Why this needs its own circuit: the adversary here is the agent itself. The
//! agent holds the spending key `sk` of its notes, so the policy must be enforced
//! by the ONLY circuit that accepts those notes without the admin key. Policy-bound
//! notes (policy != 0) are rejected by `transact` unless the admin signs off.
//!
//! STATEMENT:
//!   1. Two value notes (owner_pk(sk), policy P, label L, token) exist in `root`
//!      (zero-value inputs are dummies) and `nullifiers` are theirs.
//!   2. A BUDGET note (remaining, period, owner_pk(sk), P) exists in `root` and
//!      `budget_nullifier` is its nullifier. It is consumed by this payment.
//!   3. P opens to policy parameters (admin, token, caps, period, vendor level, categories).
//!   4. If the policy requires it (`vendor_checked` == policy.require_verified_vendor,
//!      public): `recipient` is a VERIFIED VENDOR: the leaf (recipient, level, categories,
//!      expiry) is in the Grayr vendor tree `vendor_root`, level >= policy.min_vendor_level,
//!      expiry >= now, and the category is allowed. Otherwise any recipient (caps + budget
//!      still apply); the contract then requires vendor_root == 0.
//!   5. 0 < amount <= policy.max_per_payment and fee <= policy.max_fee.
//!   6. Budget: period_now = now / period_seconds. If period_now > budget.period the
//!      budget rolls over to policy.period_budget; period_now < budget.period is
//!      rejected (no rollback). amount + fee <= available, and the new budget note
//!      holds available - amount - fee for period_now.
//!   7. change = in0 + in1 - amount - fee >= 0 goes back to the agent as a note
//!      with the same owner, policy and label. There is NO second output, so the
//!      agent cannot privately move policy funds anywhere but a verified vendor.
//!   8. label L is in the association set `asp_root`.
//!
//! `now` is checked by the contract against block.timestamp (bounded staleness).
//! `context` binds chainId, pool, fee recipient, x402 request id, deadline.
use shielded::{
    budget_commitment, merkle_root, note_commitment, nullifier, nullifier_key, owner_pk,
    vendor_leaf, Policy, ASP_TREE_DEPTH, NOTE_TREE_DEPTH, VENDOR_TREE_DEPTH,
};

fn main(
    // ----------------------------- public -----------------------------
    root: pub Field,
    asp_root: pub Field,
    vendor_root: pub Field,
    vendor_checked: pub bool,
    nullifiers: pub [Field; 2],
    budget_nullifier: pub Field,
    change_commitment: pub Field,
    new_budget_commitment: pub Field,
    amount: pub u128,
    fee: pub u128,
    token: pub Field,
    recipient: pub Field,
    now: pub u64,
    context: pub Field,
    // ----------------------------- private ----------------------------
    sk: Field,
    label: Field,
    asp_index: Field,
    asp_path: [Field; ASP_TREE_DEPTH],
    policy_params: Policy,
    in_amounts: [u128; 2],
    in_blindings: [Field; 2],
    in_indices: [Field; 2],
    in_paths: [[Field; NOTE_TREE_DEPTH]; 2],
    budget_remaining: u128,
    budget_period: u64,
    budget_blinding: Field,
    budget_index: Field,
    budget_path: [Field; NOTE_TREE_DEPTH],
    vendor_level: u8,
    vendor_categories: u64,
    vendor_expiry: u64,
    vendor_index: Field,
    vendor_path: [Field; VENDOR_TREE_DEPTH],
    change_blinding: Field,
    new_budget_blinding: Field,
) {
    let _ = context; // bound as a public input only

    let owner = owner_pk(sk);
    let nk = nullifier_key(sk);
    let policy = policy_params.hash();

    // (3) the policy is for this token
    assert(policy_params.token == token, "policy token mismatch");

    // (1) value inputs
    let mut sum_in: Field = 0;
    for i in 0..2 {
        let cm = note_commitment(in_amounts[i] as Field, token, label, owner, in_blindings[i], policy);
        if in_amounts[i] != 0 {
            assert(merkle_root(cm, in_indices[i], in_paths[i]) == root, "input not in tree");
        }
        assert(nullifier(nk, cm, in_indices[i]) == nullifiers[i], "bad nullifier");
        sum_in += in_amounts[i] as Field;
    }

    // (2) budget input: ALWAYS required, so every policy payment consumes the budget
    let bcm = budget_commitment(
        budget_remaining as Field,
        budget_period as Field,
        owner,
        budget_blinding,
        policy,
    );
    assert(merkle_root(bcm, budget_index, budget_path) == root, "budget not in tree");
    assert(nullifier(nk, bcm, budget_index) == budget_nullifier, "bad budget nullifier");

    assert(nullifiers[0] != nullifiers[1], "duplicate nullifier");
    assert(nullifiers[0] != budget_nullifier, "duplicate nullifier");
    assert(nullifiers[1] != budget_nullifier, "duplicate nullifier");

    // (4) verified merchant, if the (private) policy requires it. The public bit must equal
    // the policy's flag, so an agent whose policy requires verification can't claim otherwise.
    assert(vendor_checked == policy_params.require_verified_vendor, "vendor_checked != policy flag");
    let leaf = vendor_leaf(
        recipient,
        vendor_level as Field,
        vendor_categories as Field,
        vendor_expiry as Field,
    );
    let vendor_root_ok = merkle_root(leaf, vendor_index, vendor_path) == vendor_root;
    if vendor_checked {
        assert(vendor_root_ok, "merchant not verified");
        assert(vendor_level >= policy_params.min_vendor_level, "merchant level too low");
        assert(vendor_expiry >= now, "vendor leaf expired");
        if policy_params.category_mask != 0 {
            assert((vendor_categories & policy_params.category_mask) != 0, "category not allowed");
        }
    }

    // (5) per-payment caps
    assert(amount > 0, "zero payment");
    assert(amount <= policy_params.max_per_payment, "over per-payment cap");
    assert(fee <= policy_params.max_fee, "fee over cap");

    // (6) budget period + rollover
    assert(policy_params.period_seconds > 0, "bad period");
    let period_now = now / policy_params.period_seconds; // constrained integer division
    assert(period_now >= budget_period, "budget period rollback");
    let available: u128 = if period_now > budget_period {
        policy_params.period_budget
    } else {
        budget_remaining
    };
    let spend = amount + fee; // u128 add: overflow-checked
    assert(spend <= available, "over budget");
    let new_remaining = available - spend;
    let new_bcm = budget_commitment(
        new_remaining as Field,
        period_now as Field,
        owner,
        new_budget_blinding,
        policy,
    );
    assert(new_bcm == new_budget_commitment, "bad new budget");

    // (7) change back to the agent, same owner/policy/label
    let change: Field = sum_in - amount as Field - fee as Field;
    // A negative result would wrap to ~2^254; this range check rejects it.
    change.assert_max_bit_size::<128>();
    let ccm = note_commitment(change, token, label, owner, change_blinding, policy);
    assert(ccm == change_commitment, "bad change");

    // (8) association set
    assert(merkle_root(label, asp_index, asp_path) == asp_root, "label not in association set");
}
