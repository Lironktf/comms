use anchor_lang::prelude::*;

#[error_code]
pub enum ActpError {
    #[msg("registry is paused")]
    Paused,
    #[msg("caller is not authorized for this action")]
    Unauthorized,
    #[msg("caller is not the vendor owner")]
    NotVendorOwner,
    #[msg("caller is not the pending owner")]
    NotPendingOwner,
    #[msg("invalid or non-normalized domain")]
    InvalidDomain,
    #[msg("vendor id does not match the provided domain")]
    VendorIdMismatch,
    #[msg("domain hash does not match the provided domain")]
    DomainHashMismatch,
    #[msg("vendor is not active")]
    VendorNotActive,
    #[msg("vendor is revoked (terminal)")]
    VendorRevoked,
    #[msg("invalid vendor status transition")]
    InvalidStatusTransition,
    #[msg("cannot remove the primary domain")]
    CannotRemovePrimaryDomain,
    #[msg("metadata/contract hash must not be zero")]
    ZeroHash,
    #[msg("no metadata anchored to sign")]
    NoMetadataToSign,
    #[msg("invalid attestation type")]
    InvalidAttestationType,
    #[msg("attestation expiry is out of bounds")]
    InvalidExpiry,
    #[msg("signer is not an authorized verifier")]
    SignerNotVerifier,
    #[msg("claim does not belong to this vendor")]
    ClaimVendorMismatch,
}
