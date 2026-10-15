//! M0 exercise 1: "I know the opening of this commitment".
//!
//! Public:  commitment
//! Private: amount, secret
//! Statement: commitment == H3(amount, secret, 0) AND amount < 2^64.
//!
//! The verifier learns nothing about `amount` or `secret` except that they exist.
//! Try it: change Prover.toml's amount and `nargo execute` fails, because the
//! assertion is part of the circuit. A proof can only be made for a TRUE statement.
use shielded::h3;

fn main(commitment: pub Field, amount: u64, secret: Field) {
    // `amount: u64` is a typed input: Noir range-constrains it to 64 bits automatically.
    assert(h3(amount as Field, secret, 0) == commitment);
}

#[test]
fn opens() {
    main(h3(42, 7, 0), 42, 7);
}

#[test(should_fail)]
fn wrong_secret_fails() {
    main(h3(42, 7, 0), 42, 8);
}
