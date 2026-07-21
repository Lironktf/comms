import {keccak256, toBytes, type Hex} from "viem";
import {canonicalize} from "@actp/core";

/**
 * ACTP V2 level-3 backing — Know-Your-Business verification.
 *
 * Verification levels are only as meaningful as what backs them. This is the pluggable seam
 * for that backing: a `KybProvider` runs a business check and returns a result whose evidence
 * hash a verifier then anchors onchain as a LegalEntityVerified (level 3) attestation. The raw
 * KYB evidence (documents, UBO, filings) stays offchain — only the "a check passed, by whom,
 * over this evidence" fact goes on chain.
 *
 * Same pattern as the contract-intelligence extractor: a deterministic stub for dev/test, and
 * an interface a real provider (Middesk, Persona, Trulioo, or an LEI/vLEI lookup) drops into.
 */

export interface KybInput {
  vendorId: string;
  legalName?: string;
  /** e.g. a 20-char GLEIF LEI, or a jurisdiction registration number */
  registrationId?: string;
  jurisdiction?: string;
}

export interface KybResult {
  passed: boolean;
  provider: string;
  legalName: string | null;
  registrationId: string | null;
  jurisdiction: string | null;
  /** keccak256 over the canonical result — the evidence hash for the onchain attestation */
  evidenceHash: Hex;
  detail: Record<string, unknown>;
  checkedAt: string;
}

export interface KybProvider {
  readonly name: string;
  verify(input: KybInput): Promise<KybResult>;
}

/**
 * Deterministic stub: passes when a plausible legal-entity identifier is present — a
 * well-formed GLEIF LEI (20 alphanumerics) or a jurisdiction + registration number. No
 * network, fully reproducible; stands in for a real KYB API in dev/test.
 */
export class StubKybProvider implements KybProvider {
  readonly name = "stub-kyb";

  async verify(input: KybInput): Promise<KybResult> {
    const lei = input.registrationId ?? "";
    const isLei = /^[A-Z0-9]{20}$/.test(lei);
    const hasJurisdictionReg = Boolean(input.jurisdiction && input.registrationId);
    const passed = Boolean(input.legalName) && (isLei || hasJurisdictionReg);

    const detail = {method: isLei ? "lei" : hasJurisdictionReg ? "jurisdiction_registry" : "insufficient", passed};
    const checkedAt = new Date().toISOString();
    const evidenceHash = keccak256(
      toBytes(canonicalize({provider: this.name, input, detail, checkedAt: checkedAt.slice(0, 10)})),
    );
    return {
      passed,
      provider: this.name,
      legalName: input.legalName ?? null,
      registrationId: input.registrationId ?? null,
      jurisdiction: input.jurisdiction ?? null,
      evidenceHash,
      detail,
      checkedAt,
    };
  }
}
