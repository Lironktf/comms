import type {RiskLevel, RiskSignals} from "@actp/core";

/**
 * ACTP V5 — versioned, explainable risk ruleset.
 *
 * Design constraints:
 *  - Deterministic: same signals + same ruleset version => same score, always.
 *  - Explainable: every point of score is attributable to a named rule with evidence.
 *  - Fail-closed: missing data raises risk (an unknown domain age is a signal, not a blank).
 *  - Overrides: certain facts (sanctions, revocation) short-circuit arithmetic entirely.
 *
 * Scores are comparable only within a ruleset version. Changing ANY weight requires a
 * version bump.
 */

export interface RuleResult {
  rule: string;
  weight: number;
  evidence: Record<string, unknown>;
}

export interface RuleOverride extends RuleResult {
  /** Forces the final level regardless of the numeric score. */
  forceLevel: RiskLevel;
  /** Floor applied to the numeric score. */
  minScore: number;
}

export interface Ruleset {
  version: string;
  levelBounds: {low: number; medium: number; high: number}; // upper bounds; >= high => critical
  evaluate(s: RiskSignals): {results: RuleResult[]; overrides: RuleOverride[]};
}

export const RULESET_V1: Ruleset = {
  version: "1.0.0",
  levelBounds: {low: 20, medium: 50, high: 80},

  evaluate(s: RiskSignals) {
    const results: RuleResult[] = [];
    const overrides: RuleOverride[] = [];
    const add = (rule: string, weight: number, evidence: Record<string, unknown>) =>
      results.push({rule, weight, evidence});

    // ----- hard overrides ------------------------------------------------
    if (s.sanctionsMatch) {
      overrides.push({
        rule: "sanctions.match",
        weight: 100,
        evidence: {sanctionsMatch: true},
        forceLevel: "critical",
        minScore: 100,
      });
    }
    if (s.vendorStatus === "revoked") {
      overrides.push({
        rule: "registry.status.revoked",
        weight: 100,
        evidence: {status: "revoked"},
        forceLevel: "critical",
        minScore: 100,
      });
    }
    if (s.vendorStatus === "suspended") {
      overrides.push({
        rule: "registry.status.suspended",
        weight: 70,
        evidence: {status: "suspended"},
        forceLevel: "high",
        minScore: 70,
      });
    }

    // ----- verification (V2) ----------------------------------------------
    if (s.verificationLevel === 0) add("verification.unverified", 25, {level: 0});
    else if (s.verificationLevel <= 2) add("verification.basic_only", 10, {level: s.verificationLevel});
    // level >= 3 contributes no risk

    if ((s.expiredAttestations ?? 0) > 0) {
      add("attestation.expired_unrenewed", 10, {expiredAttestations: s.expiredAttestations});
    }

    // ----- age signals ------------------------------------------------------
    if (s.registryAgeDays < 7) add("registry.age.lt_7d", 15, {registryAgeDays: s.registryAgeDays});
    else if (s.registryAgeDays < 30) add("registry.age.lt_30d", 10, {registryAgeDays: s.registryAgeDays});
    else if (s.registryAgeDays < 90) add("registry.age.lt_90d", 5, {registryAgeDays: s.registryAgeDays});

    if (s.domainAgeDays === undefined) {
      add("domain.age.unknown", 10, {domainAgeDays: null});
    } else if (s.domainAgeDays < 90) {
      add("domain.age.lt_90d", 20, {domainAgeDays: s.domainAgeDays});
    } else if (s.domainAgeDays < 365) {
      add("domain.age.lt_1y", 8, {domainAgeDays: s.domainAgeDays});
    }

    // ----- wallet history -----------------------------------------------------
    if (s.walletFlagged) add("wallet.flagged", 40, {walletFlagged: true});
    else if (s.walletAgeDays !== undefined && s.walletAgeDays < 30) {
      add("wallet.age.lt_30d", 10, {walletAgeDays: s.walletAgeDays});
    }

    // ----- abuse reports ------------------------------------------------------
    if ((s.phishingReports ?? 0) > 0) {
      add("reports.phishing", Math.min(30, 15 + 5 * (s.phishingReports ?? 0)), {
        phishingReports: s.phishingReports,
      });
    }
    if ((s.securityIncidents ?? 0) > 0) {
      add("reports.security_incidents", Math.min(30, 10 * (s.securityIncidents ?? 0)), {
        securityIncidents: s.securityIncidents,
      });
    }
    if ((s.refundComplaints ?? 0) >= 3) {
      add("reports.refund_complaints", Math.min(20, 5 * (s.refundComplaints ?? 0)), {
        refundComplaints: s.refundComplaints,
      });
    }

    // ----- metadata integrity (V3) ------------------------------------------------
    switch (s.metadataIntegrity) {
      case "hash_mismatch":
        add("metadata.integrity.hash_mismatch", 25, {metadataIntegrity: s.metadataIntegrity});
        break;
      case "not_anchored":
        add("metadata.integrity.not_anchored", 5, {metadataIntegrity: s.metadataIntegrity});
        break;
      case "no_document":
        add("metadata.integrity.no_document", 8, {metadataIntegrity: s.metadataIntegrity});
        break;
      case "verified":
        break;
    }

    return {results, overrides};
  },
};

export const RULESETS: Record<string, Ruleset> = {
  [RULESET_V1.version]: RULESET_V1,
};
