//! ACTP registry — Solana/Anchor port of the EVM VendorRegistry + AttestationRegistry
//! (ACTP V1 + V2). Consolidated into one program: on Solana a single program with many
//! instruction handlers is idiomatic and avoids cross-program-invocation overhead, and the
//! EVM reason for two contracts (independent UUPS upgradeability) is handled here by the
//! BPF upgradeable loader's per-program upgrade authority instead.
//!
//! Design notes vs EVM:
//!  - Uniqueness is native: a DomainClaim / WalletClaim is a PDA seeded by the domain hash /
//!    wallet pubkey, so a duplicate claim simply fails to `init`. Claims of a revoked vendor
//!    are never closed → the identity is quarantined forever.
//!  - No EIP-712 relayed attestations: a Solana verifier signs the transaction directly, and
//!    replay is handled by the runtime (recent blockhash), so the EVM nonce machinery is gone.
//!  - Verification level is computed off-chain from the attestation accounts (as the backend
//!    already does), the same way the EVM `verificationLevel()` view was a convenience.

use anchor_lang::prelude::*;

pub mod domain;
pub mod errors;
pub mod id;
pub mod state;

use errors::ActpError;
use state::*;

declare_id!("ACTPreg1stryVoTEkm11111111111111111111111111");

const ZERO_HASH: [u8; 32] = [0u8; 32];

#[program]
pub mod actp_registry {
    use super::*;

    // ---------------------------------------------------------------- config / roles
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let admin = ctx.accounts.admin.key();
        c.admin = admin;
        c.guardian = admin;
        c.verifier_admin = admin;
        c.paused = false;
        c.vendor_count = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_roles(
        ctx: Context<AdminOnly>,
        new_admin: Pubkey,
        new_guardian: Pubkey,
        new_verifier_admin: Pubkey,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = new_admin;
        c.guardian = new_guardian;
        c.verifier_admin = new_verifier_admin;
        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = false;
        Ok(())
    }

    // ---------------------------------------------------------------- V1 registration
    pub fn register_vendor(
        ctx: Context<RegisterVendor>,
        vendor_id: [u8; 32],
        primary_domain_hash: [u8; 32],
        primary_domain: String,
        x402_endpoint: String,
        metadata_hash: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require!(domain::is_valid(&primary_domain), ActpError::InvalidDomain);
        require!(id::derive_vendor_id(&primary_domain) == vendor_id, ActpError::VendorIdMismatch);
        require!(id::domain_hash(&primary_domain) == primary_domain_hash, ActpError::DomainHashMismatch);

        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vendor;
        v.vendor_id = vendor_id;
        v.owner = ctx.accounts.owner.key();
        v.pending_owner = None;
        v.status = VendorStatus::Active;
        v.registered_at = now;
        v.updated_at = now;
        v.metadata_version = 0;
        v.contract_metadata_version = 0;
        v.metadata_hash = ZERO_HASH;
        v.contract_metadata_hash = ZERO_HASH;
        v.domain_count = 1;
        v.wallet_count = 0;
        v.primary_domain = primary_domain.clone();
        v.x402_endpoint = x402_endpoint;
        v.metadata_uri = String::new();
        v.bump = ctx.bumps.vendor;

        if metadata_hash != ZERO_HASH {
            v.metadata_hash = metadata_hash;
            v.metadata_uri = metadata_uri;
            v.metadata_version = 1;
        }

        let claim = &mut ctx.accounts.domain_claim;
        claim.vendor_id = vendor_id;
        claim.domain = primary_domain;
        claim.bump = ctx.bumps.domain_claim;

        ctx.accounts.config.vendor_count += 1;
        Ok(())
    }

    pub fn add_domain(
        ctx: Context<AddDomain>,
        _vendor_id: [u8; 32],
        domain_hash: [u8; 32],
        domain: String,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(domain::is_valid(&domain), ActpError::InvalidDomain);
        require!(id::domain_hash(&domain) == domain_hash, ActpError::DomainHashMismatch);

        let claim = &mut ctx.accounts.domain_claim;
        claim.vendor_id = ctx.accounts.vendor.vendor_id;
        claim.domain = domain;
        claim.bump = ctx.bumps.domain_claim;

        let v = &mut ctx.accounts.vendor;
        v.domain_count += 1;
        touch(v)?;
        Ok(())
    }

    pub fn remove_domain(
        ctx: Context<RemoveDomain>,
        _vendor_id: [u8; 32],
        domain_hash: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(
            ctx.accounts.domain_claim.vendor_id == ctx.accounts.vendor.vendor_id,
            ActpError::ClaimVendorMismatch
        );
        require!(
            id::domain_hash(&ctx.accounts.vendor.primary_domain) != domain_hash,
            ActpError::CannotRemovePrimaryDomain
        );
        let v = &mut ctx.accounts.vendor;
        v.domain_count = v.domain_count.saturating_sub(1);
        touch(v)?;
        Ok(()) // domain_claim closed via account constraint (lamports back to owner)
    }

    pub fn add_wallet(ctx: Context<AddWallet>, _vendor_id: [u8; 32], wallet: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        let claim = &mut ctx.accounts.wallet_claim;
        claim.vendor_id = ctx.accounts.vendor.vendor_id;
        claim.wallet = wallet;
        claim.bump = ctx.bumps.wallet_claim;
        let v = &mut ctx.accounts.vendor;
        v.wallet_count += 1;
        touch(v)?;
        Ok(())
    }

    pub fn remove_wallet(ctx: Context<RemoveWallet>, _vendor_id: [u8; 32], _wallet: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(
            ctx.accounts.wallet_claim.vendor_id == ctx.accounts.vendor.vendor_id,
            ActpError::ClaimVendorMismatch
        );
        let v = &mut ctx.accounts.vendor;
        v.wallet_count = v.wallet_count.saturating_sub(1);
        touch(v)?;
        Ok(())
    }

    pub fn set_x402_endpoint(ctx: Context<VendorEdit>, _vendor_id: [u8; 32], endpoint: String) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        let v = &mut ctx.accounts.vendor;
        v.x402_endpoint = endpoint;
        touch(v)?;
        Ok(())
    }

    pub fn set_metadata(
        ctx: Context<VendorEdit>,
        _vendor_id: [u8; 32],
        metadata_hash: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(metadata_hash != ZERO_HASH, ActpError::ZeroHash);
        let v = &mut ctx.accounts.vendor;
        v.metadata_hash = metadata_hash;
        v.metadata_uri = metadata_uri;
        v.metadata_version += 1;
        touch(v)?;
        Ok(())
    }

    pub fn set_contract_metadata(
        ctx: Context<VendorEdit>,
        _vendor_id: [u8; 32],
        contract_metadata_hash: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ActpError::Paused);
        require_active(&ctx.accounts.vendor)?;
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(contract_metadata_hash != ZERO_HASH, ActpError::ZeroHash);
        let v = &mut ctx.accounts.vendor;
        v.contract_metadata_hash = contract_metadata_hash;
        v.contract_metadata_version += 1;
        touch(v)?;
        Ok(())
    }

    // ---------------------------------------------------------------- ownership (two-step)
    pub fn transfer_ownership(ctx: Context<VendorEdit>, _vendor_id: [u8; 32], new_owner: Pubkey) -> Result<()> {
        require_owner(&ctx.accounts.vendor, &ctx.accounts.owner)?;
        require!(ctx.accounts.vendor.status != VendorStatus::Revoked, ActpError::VendorRevoked);
        ctx.accounts.vendor.pending_owner = Some(new_owner);
        Ok(())
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>, _vendor_id: [u8; 32]) -> Result<()> {
        let v = &mut ctx.accounts.vendor;
        require!(v.status != VendorStatus::Revoked, ActpError::VendorRevoked);
        require!(v.pending_owner == Some(ctx.accounts.new_owner.key()), ActpError::NotPendingOwner);
        v.owner = ctx.accounts.new_owner.key();
        v.pending_owner = None;
        touch(v)?;
        Ok(())
    }

    // ---------------------------------------------------------------- lifecycle (guardian)
    pub fn suspend(ctx: Context<GuardianAction>, _vendor_id: [u8; 32]) -> Result<()> {
        transition(&mut ctx.accounts.vendor, VendorStatus::Suspended)
    }
    pub fn unsuspend(ctx: Context<GuardianAction>, _vendor_id: [u8; 32]) -> Result<()> {
        transition(&mut ctx.accounts.vendor, VendorStatus::Active)
    }

    /// Terminal removal — callable by the guardian or the vendor owner.
    pub fn revoke(ctx: Context<RevokeVendor>, _vendor_id: [u8; 32]) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.config.guardian || signer == ctx.accounts.vendor.owner,
            ActpError::Unauthorized
        );
        transition(&mut ctx.accounts.vendor, VendorStatus::Revoked)
    }

    // ---------------------------------------------------------------- V2 verifiers
    pub fn grant_verifier(ctx: Context<GrantVerifier>, authority: Pubkey) -> Result<()> {
        let vf = &mut ctx.accounts.verifier;
        vf.authority = authority;
        vf.bump = ctx.bumps.verifier;
        Ok(())
    }

    pub fn revoke_verifier(_ctx: Context<RevokeVerifier>, _authority: Pubkey) -> Result<()> {
        Ok(()) // verifier PDA closed via account constraint
    }

    // ---------------------------------------------------------------- V2 attestations
    pub fn attest(
        ctx: Context<Attest>,
        _vendor_id: [u8; 32],
        att_type: u8,
        evidence_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        require!(ctx.accounts.vendor.status == VendorStatus::Active, ActpError::VendorNotActive);
        require!(
            att_type == att_type::DOMAIN_VERIFIED
                || att_type == att_type::WALLET_VERIFIED
                || att_type == att_type::LEGAL_ENTITY_VERIFIED
                || att_type == att_type::AUDITED,
            ActpError::InvalidAttestationType
        );
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now && expires_at <= now + MAX_VALIDITY_SECS, ActpError::InvalidExpiry);

        let a = &mut ctx.accounts.attestation;
        a.vendor_id = ctx.accounts.vendor.vendor_id;
        a.att_type = att_type;
        a.evidence_hash = evidence_hash;
        a.issued_at = now;
        a.expires_at = expires_at;
        a.attester = ctx.accounts.attester.key();
        a.revoked = false;
        a.bump = ctx.bumps.attestation;
        Ok(())
    }

    /// ACTP level 4: the vendor owner signs the currently anchored metadata hash.
    pub fn vendor_sign_metadata(ctx: Context<VendorSignMetadata>, _vendor_id: [u8; 32]) -> Result<()> {
        let v = &ctx.accounts.vendor;
        require!(v.status == VendorStatus::Active, ActpError::VendorNotActive);
        require_owner(v, &ctx.accounts.owner)?;
        require!(v.metadata_hash != ZERO_HASH, ActpError::NoMetadataToSign);
        let now = Clock::get()?.unix_timestamp;

        let a = &mut ctx.accounts.attestation;
        a.vendor_id = v.vendor_id;
        a.att_type = att_type::VENDOR_SIGNED;
        a.evidence_hash = v.metadata_hash;
        a.issued_at = now;
        a.expires_at = now + VENDOR_SIGNED_VALIDITY_SECS;
        a.attester = ctx.accounts.owner.key();
        a.revoked = false;
        a.bump = ctx.bumps.attestation;
        Ok(())
    }

    pub fn revoke_attestation(ctx: Context<RevokeAttestation>, _vendor_id: [u8; 32], _att_type: u8) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.attestation.attester || signer == ctx.accounts.config.verifier_admin,
            ActpError::Unauthorized
        );
        ctx.accounts.attestation.revoked = true;
        Ok(())
    }

    pub fn ban_attester(ctx: Context<BanAttester>, attester: Pubkey, cutoff: i64) -> Result<()> {
        let b = &mut ctx.accounts.ban;
        b.attester = attester;
        b.cutoff = cutoff;
        b.bump = ctx.bumps.ban;
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers
fn touch(v: &mut Account<Vendor>) -> Result<()> {
    v.updated_at = Clock::get()?.unix_timestamp;
    Ok(())
}

fn require_active(v: &Account<Vendor>) -> Result<()> {
    require!(v.status == VendorStatus::Active, ActpError::VendorNotActive);
    Ok(())
}

fn require_owner(v: &Account<Vendor>, signer: &Signer) -> Result<()> {
    require!(v.owner == signer.key(), ActpError::NotVendorOwner);
    Ok(())
}

fn transition(v: &mut Account<Vendor>, to: VendorStatus) -> Result<()> {
    let from = v.status;
    let ok = matches!(
        (from, to),
        (VendorStatus::Active, VendorStatus::Suspended)
            | (VendorStatus::Active, VendorStatus::Revoked)
            | (VendorStatus::Suspended, VendorStatus::Active)
            | (VendorStatus::Suspended, VendorStatus::Revoked)
    );
    require!(ok, ActpError::InvalidStatusTransition);
    v.status = to;
    touch(v)?;
    Ok(())
}

// ================================================================ Accounts contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ActpError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], primary_domain_hash: [u8; 32])]
pub struct RegisterVendor<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = owner, space = 8 + Vendor::INIT_SPACE, seeds = [b"vendor", vendor_id.as_ref()], bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(init, payer = owner, space = 8 + DomainClaim::INIT_SPACE, seeds = [b"domain", primary_domain_hash.as_ref()], bump)]
    pub domain_claim: Account<'info, DomainClaim>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], domain_hash: [u8; 32])]
pub struct AddDomain<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(init, payer = owner, space = 8 + DomainClaim::INIT_SPACE, seeds = [b"domain", domain_hash.as_ref()], bump)]
    pub domain_claim: Account<'info, DomainClaim>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], domain_hash: [u8; 32])]
pub struct RemoveDomain<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(mut, close = owner, seeds = [b"domain", domain_hash.as_ref()], bump = domain_claim.bump)]
    pub domain_claim: Account<'info, DomainClaim>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], wallet: Pubkey)]
pub struct AddWallet<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(init, payer = owner, space = 8 + WalletClaim::INIT_SPACE, seeds = [b"wallet", wallet.as_ref()], bump)]
    pub wallet_claim: Account<'info, WalletClaim>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], wallet: Pubkey)]
pub struct RemoveWallet<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(mut, close = owner, seeds = [b"wallet", wallet.as_ref()], bump = wallet_claim.bump)]
    pub wallet_claim: Account<'info, WalletClaim>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32])]
pub struct VendorEdit<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32])]
pub struct AcceptOwnership<'info> {
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    pub new_owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32])]
pub struct GuardianAction<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = guardian @ ActpError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32])]
pub struct RevokeVendor<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(authority: Pubkey)]
pub struct GrantVerifier<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = verifier_admin @ ActpError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub verifier_admin: Signer<'info>,
    #[account(init, payer = verifier_admin, space = 8 + Verifier::INIT_SPACE, seeds = [b"verifier", authority.as_ref()], bump)]
    pub verifier: Account<'info, Verifier>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(authority: Pubkey)]
pub struct RevokeVerifier<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = verifier_admin @ ActpError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub verifier_admin: Signer<'info>,
    #[account(mut, close = verifier_admin, seeds = [b"verifier", authority.as_ref()], bump = verifier.bump)]
    pub verifier: Account<'info, Verifier>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], att_type: u8)]
pub struct Attest<'info> {
    #[account(seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    // existence of this PDA (seeded by the signer) is the VERIFIER_ROLE check
    #[account(seeds = [b"verifier", attester.key().as_ref()], bump = verifier.bump)]
    pub verifier: Account<'info, Verifier>,
    #[account(
        init_if_needed,
        payer = attester,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [b"att", vendor_id.as_ref(), &[att_type]],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    #[account(mut)]
    pub attester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32])]
pub struct VendorSignMetadata<'info> {
    #[account(seeds = [b"vendor", vendor_id.as_ref()], bump = vendor.bump)]
    pub vendor: Account<'info, Vendor>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [b"att", vendor_id.as_ref(), &[att_type::VENDOR_SIGNED]],
        bump
    )]
    pub attestation: Account<'info, Attestation>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vendor_id: [u8; 32], att_type: u8)]
pub struct RevokeAttestation<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"att", vendor_id.as_ref(), &[att_type]], bump = attestation.bump)]
    pub attestation: Account<'info, Attestation>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(attester: Pubkey)]
pub struct BanAttester<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = verifier_admin @ ActpError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub verifier_admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = verifier_admin,
        space = 8 + Ban::INIT_SPACE,
        seeds = [b"ban", attester.as_ref()],
        bump
    )]
    pub ban: Account<'info, Ban>,
    pub system_program: Program<'info, System>,
}
