import type {Hex} from "viem";

// ---------------------------------------------------------------------------
// Onchain mirrors
// ---------------------------------------------------------------------------

export enum VendorStatus {
  None = 0,
  Active = 1,
  Suspended = 2,
  Revoked = 3,
}

export enum AttestationType {
  None = 0,
  DomainVerified = 1,
  WalletVerified = 2,
  LegalEntityVerified = 3,
  VendorSigned = 4,
  Audited = 5,
}

export const VERIFICATION_LEVEL_NAMES: Record<number, string> = {
  0: "unverified",
  1: "domain_verified",
  2: "wallet_verified",
  3: "legal_entity_verified",
  4: "vendor_signed",
  5: "audited",
};

export interface VendorRecord {
  vendorId: Hex;
  owner: Hex;
  status: "active" | "suspended" | "revoked";
  primaryDomain: string;
  domains: string[];
  wallets: Hex[];
  x402Endpoint: string | null;
  metadataHash: Hex | null;
  metadataUri: string | null;
  metadataVersion: number;
  contractMetadataHash: Hex | null;
  contractMetadataVersion: number;
  verificationLevel: number;
  registeredAt: string; // ISO 8601
  updatedAt: string;
}

export interface AttestationRecord {
  attestationId: Hex;
  vendorId: Hex;
  attType: AttestationType;
  evidenceHash: Hex;
  issuedAt: string;
  expiresAt: string;
  attester: Hex;
  revoked: boolean;
  active: boolean;
}

// ---------------------------------------------------------------------------
// V4 — Contract Intelligence
// ---------------------------------------------------------------------------

/**
 * Provenance of a piece of contract-terms data. AI output is NEVER presented as verified:
 *  - merchant_declared:   published by the vendor and hash-anchored onchain by its owner key
 *  - verifier_attested:   confirmed by a registry verifier
 *  - deterministic_parse: rule/pattern extraction from a source document
 *  - ai_extracted:        LLM extraction from a source document
 */
export type TermSource = "merchant_declared" | "verifier_attested" | "deterministic_parse" | "ai_extracted";

export interface SourceReference {
  /** keccak256 of the source document's raw content */
  documentHash: Hex;
  /** verbatim excerpt supporting the extraction */
  excerpt?: string;
  /** character offset of the excerpt in the document */
  offset?: number;
}

export interface ExtractedField<T> {
  value: T;
  /** [0,1]; consumers MUST treat < 1 as unverified information, not fact */
  confidence: number;
  source: TermSource;
  references: SourceReference[];
  /** set when confidence is below the review threshold */
  requiresReview?: boolean;
}

export interface ContractTerms {
  schema: "actp.contract-terms.v1";
  vendorId: Hex;
  trialDays?: ExtractedField<number>;
  renewalCadence?: ExtractedField<"monthly" | "annual" | "none" | "other">;
  renewalPrice?: ExtractedField<{amount: string; currency: string}>;
  autoRenews?: ExtractedField<boolean>;
  cancellationMethod?: ExtractedField<"self_service" | "email" | "phone" | "written_notice" | "other">;
  cancellationDeadlineDays?: ExtractedField<number>;
  refundPolicy?: ExtractedField<{type: "full" | "prorated" | "none" | "conditional"; windowDays?: number}>;
  earlyTerminationFee?: ExtractedField<{present: boolean; amount?: string; currency?: string}>;
  priceIncreaseClause?: ExtractedField<{present: boolean; noticeDays?: number}>;
  arbitrationClause?: ExtractedField<{present: boolean; binding?: boolean; classActionWaiver?: boolean}>;
  extractorVersion: string;
  extractedAt: string;
}

// ---------------------------------------------------------------------------
// V5 — Risk Engine
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskReason {
  rule: string;
  weight: number;
  evidence: Record<string, unknown>;
}

export interface RiskScore {
  vendorId: Hex;
  riskLevel: RiskLevel;
  /** 0–100, higher = riskier */
  score: number;
  reasons: RiskReason[];
  rulesetVersion: string;
  evaluatedAt: string;
  /** keccak256 of the canonicalized signal inputs — makes every score reproducible */
  inputsSnapshotHash: Hex;
}

/** Signals consumed by the risk engine. All optional; missing data is itself a signal. */
export interface RiskSignals {
  verificationLevel: number;
  vendorStatus: "active" | "suspended" | "revoked";
  registryAgeDays: number;
  domainAgeDays?: number;
  walletAgeDays?: number;
  walletFlagged?: boolean;
  sanctionsMatch?: boolean;
  phishingReports?: number;
  securityIncidents?: number;
  refundComplaints?: number;
  metadataIntegrity: "verified" | "hash_mismatch" | "not_anchored" | "no_document";
  expiredAttestations?: number;
}
