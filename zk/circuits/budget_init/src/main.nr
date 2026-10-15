//! budget_init: the policy ADMIN creates a fresh budget note for an agent.
//!
//! This is the only way a budget note can come into existence (policy_pay only
//! ever replaces one budget note with exactly one successor), so the agent cannot
//! forge budget: it would need `admin_sk`.
//!
//! STATEMENT: the prover knows admin_sk with admin_pk(admin_sk) == policy.admin_pk,
//! and `budget_commitment` is a budget note for owner `agent_owner` and policy P
//! holding exactly policy.period_budget for period now / period_seconds.
//!
//! Replay: re-submitting the same proof would insert the same commitment again (at a
//! new leaf index, hence spendable twice). The contract therefore records every
//! initialized budget commitment and rejects duplicates. `context` binds chain/pool/deadline.
use shielded::{admin_pk, budget_commitment, Policy};

fn main(
    budget_commitment_out: pub Field,
    now: pub u64,
    context: pub Field,
    admin_sk: Field,
    policy_params: Policy,
    agent_owner: Field,
    blinding: Field,
) {
    let _ = context;
    assert(admin_pk(admin_sk) == policy_params.admin_pk, "not the policy admin");
    assert(policy_params.period_seconds > 0, "bad period");
    let period = now / policy_params.period_seconds;
    let cm = budget_commitment(
        policy_params.period_budget as Field,
        period as Field,
        agent_owner,
        blinding,
        policy_params.hash(),
    );
    assert(cm == budget_commitment_out, "bad budget commitment");
}

#[test]
fn admin_can_init() {
    let p = test_policy();
    let owner = 0x42;
    let cm = budget_commitment(p.period_budget as Field, (1_800_000_000 / p.period_seconds) as Field, owner, 5, p.hash());
    main(cm, 1_800_000_000, 0, 0x99, p, owner, 5);
}

#[test(should_fail_with = "not the policy admin")]
fn forged_admin_key_fails() {
    let p = test_policy();
    let owner = 0x42;
    let cm = budget_commitment(p.period_budget as Field, (1_800_000_000 / p.period_seconds) as Field, owner, 5, p.hash());
    main(cm, 1_800_000_000, 0, 0x98, p, owner, 5);
}

#[test(should_fail_with = "bad budget commitment")]
fn inflated_budget_fails() {
    let p = test_policy();
    let owner = 0x42;
    // a budget note holding MORE than period_budget can't be minted
    let cm = budget_commitment(p.period_budget as Field + 1, (1_800_000_000 / p.period_seconds) as Field, owner, 5, p.hash());
    main(cm, 1_800_000_000, 0, 0x99, p, owner, 5);
}

#[test(should_fail_with = "bad budget commitment")]
fn future_period_fails() {
    let p = test_policy();
    let owner = 0x42;
    let cm = budget_commitment(p.period_budget as Field, (1_800_000_000 / p.period_seconds) as Field + 1, owner, 5, p.hash());
    main(cm, 1_800_000_000, 0, 0x99, p, owner, 5);
}

fn test_policy() -> Policy {
    Policy {
        admin_pk: admin_pk(0x99),
        token: 0xa0b8,
        max_per_payment: 10,
        max_fee: 1,
        period_budget: 500,
        period_seconds: 86400,
        min_vendor_level: 2,
        category_mask: 0,
        require_verified_vendor: true,
    }
}
