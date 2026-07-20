//! Deterministic vendor-id and claim-hash derivation.
//!
//! `vendor_id = keccak256("actp.vendor.v1" ‖ keccak256(primary_domain))` — the same
//! domain-anchored, deterministic scheme as the EVM registry, so a vendor's identity is
//! reproducible offline and duplicate registration is impossible by construction.

use anchor_lang::solana_program::keccak;

pub const VENDOR_ID_SCHEME: &[u8] = b"actp.vendor.v1";

/// keccak256 of a domain string (used as the DomainClaim PDA seed).
pub fn domain_hash(domain: &str) -> [u8; 32] {
    keccak::hash(domain.as_bytes()).to_bytes()
}

/// Deterministic vendor id for a primary domain.
pub fn derive_vendor_id(primary_domain: &str) -> [u8; 32] {
    let inner = domain_hash(primary_domain);
    keccak::hashv(&[VENDOR_ID_SCHEME, &inner]).to_bytes()
}
