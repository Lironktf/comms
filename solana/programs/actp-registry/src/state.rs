use anchor_lang::prelude::*;

/// Vendor lifecycle. Active <-> Suspended, either -> Revoked (terminal). A revoked vendor's
/// id and its claimed domains/wallets are permanently quarantined (their claim PDAs are never
/// closed), so a burned identity can never be re-registered.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum VendorStatus {
    Active,
    Suspended,
    Revoked,
}

/// Attestation types (ACTP V2 graduated verification). VendorSigned (4) is reserved for the
/// vendor owner; verifiers issue 1,2,3,5.
pub mod att_type {
    pub const DOMAIN_VERIFIED: u8 = 1;
    pub const WALLET_VERIFIED: u8 = 2;
    pub const LEGAL_ENTITY_VERIFIED: u8 = 3;
    pub const VENDOR_SIGNED: u8 = 4;
    pub const AUDITED: u8 = 5;
}

pub const MAX_VALIDITY_SECS: i64 = 730 * 86_400;
pub const VENDOR_SIGNED_VALIDITY_SECS: i64 = 365 * 86_400;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub verifier_admin: Pubkey,
    pub paused: bool,
    pub vendor_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vendor {
    pub vendor_id: [u8; 32],
    pub owner: Pubkey,
    pub pending_owner: Option<Pubkey>,
    pub status: VendorStatus,
    pub registered_at: i64,
    pub updated_at: i64,
    pub metadata_version: u64,
    pub contract_metadata_version: u64,
    pub metadata_hash: [u8; 32],
    pub contract_metadata_hash: [u8; 32],
    pub domain_count: u32,
    pub wallet_count: u32,
    #[max_len(253)]
    pub primary_domain: String,
    #[max_len(400)]
    pub x402_endpoint: String,
    #[max_len(400)]
    pub metadata_uri: String,
    pub bump: u8,
}

/// Existence of this PDA is the uniqueness guarantee: a domain can be claimed by exactly one
/// vendor (init fails if the PDA already exists). Left in place on revoke = quarantine.
#[account]
#[derive(InitSpace)]
pub struct DomainClaim {
    pub vendor_id: [u8; 32],
    #[max_len(253)]
    pub domain: String,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WalletClaim {
    pub vendor_id: [u8; 32],
    pub wallet: Pubkey,
    pub bump: u8,
}

/// Existence of this PDA grants VERIFIER_ROLE to `authority`.
#[account]
#[derive(InitSpace)]
pub struct Verifier {
    pub authority: Pubkey,
    pub bump: u8,
}

/// Latest attestation per (vendor, type). Verification level is computed off-chain from the
/// live (unrevoked, unexpired, unbanned, vendor-active) attestation set — the indexer/service
/// does this, exactly as the EVM `verificationLevel()` view did.
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub vendor_id: [u8; 32],
    pub att_type: u8,
    pub evidence_hash: [u8; 32],
    pub issued_at: i64,
    pub expires_at: i64,
    pub attester: Pubkey,
    pub revoked: bool,
    pub bump: u8,
}

/// Compromise response: attestations issued by `attester` at or before `cutoff` are inactive.
#[account]
#[derive(InitSpace)]
pub struct Ban {
    pub attester: Pubkey,
    pub cutoff: i64,
    pub bump: u8,
}
