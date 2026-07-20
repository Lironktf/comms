import {describe, expect, it} from "vitest";
import type {RiskSignals} from "@actp/core";
import {RiskEngine} from "./engine.js";
import {RULESET_V1} from "./ruleset.js";

// Pure-core tests: no DB needed, so construct with nulls and only call score().
const engine = new RiskEngine(null as never, null as never, null as never, RULESET_V1);
const VENDOR = "0x" + "ab".repeat(32);

const baseline: RiskSignals = {
  verificationLevel: 3,
  vendorStatus: "active",
  registryAgeDays: 400,
  domainAgeDays: 2000,
  metadataIntegrity: "verified",
  expiredAttestations: 0,
};

describe("RiskEngine.score", () => {
  it("well-established verified vendor scores low with no reasons", () => {
    const s = engine.score(VENDOR, baseline);
    expect(s.riskLevel).toBe("low");
    expect(s.score).toBe(0);
    expect(s.reasons).toHaveLength(0);
    expect(s.rulesetVersion).toBe("1.0.0");
  });

  it("is deterministic and reproducible (same inputs => same output incl. snapshot hash)", () => {
    const at = new Date("2026-07-20T00:00:00Z");
    const a = engine.score(VENDOR, baseline, at);
    const b = engine.score(VENDOR, {...baseline}, at);
    expect(a).toEqual(b);
    expect(a.inputsSnapshotHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("unverified new vendor with unknown domain age scores medium+", () => {
    const s = engine.score(VENDOR, {
      verificationLevel: 0,
      vendorStatus: "active",
      registryAgeDays: 2,
      metadataIntegrity: "no_document",
    });
    // unverified(25) + registry.lt_7d(15) + domain.unknown(10) + no_document(8) = 58
    expect(s.score).toBe(58);
    expect(s.riskLevel).toBe("high");
    expect(s.reasons.map((r) => r.rule)).toContain("verification.unverified");
    expect(s.reasons.map((r) => r.rule)).toContain("domain.age.unknown");
  });

  it("every point of score is attributable to reasons", () => {
    const s = engine.score(VENDOR, {
      verificationLevel: 1,
      vendorStatus: "active",
      registryAgeDays: 20,
      domainAgeDays: 45,
      phishingReports: 1,
      metadataIntegrity: "not_anchored",
    });
    const sum = s.reasons.reduce((acc, r) => acc + r.weight, 0);
    expect(s.score).toBe(Math.min(100, sum));
    for (const r of s.reasons) {
      expect(r.rule).toBeTruthy();
      expect(r.evidence).toBeTypeOf("object");
    }
  });

  it("sanctions match overrides everything to critical/100", () => {
    const s = engine.score(VENDOR, {...baseline, sanctionsMatch: true});
    expect(s.riskLevel).toBe("critical");
    expect(s.score).toBe(100);
    expect(s.reasons[0]?.rule).toBe("sanctions.match");
  });

  it("suspended vendor is forced to at least high/70", () => {
    const s = engine.score(VENDOR, {...baseline, vendorStatus: "suspended"});
    expect(s.riskLevel).toBe("high");
    expect(s.score).toBeGreaterThanOrEqual(70);
  });

  it("revoked vendor is critical", () => {
    const s = engine.score(VENDOR, {...baseline, vendorStatus: "revoked"});
    expect(s.riskLevel).toBe("critical");
    expect(s.score).toBe(100);
  });

  it("metadata hash mismatch is a strong signal", () => {
    const s = engine.score(VENDOR, {...baseline, metadataIntegrity: "hash_mismatch"});
    expect(s.reasons.map((r) => r.rule)).toContain("metadata.integrity.hash_mismatch");
    expect(s.score).toBeGreaterThanOrEqual(25);
  });

  it("flagged wallet outweighs young wallet", () => {
    const flagged = engine.score(VENDOR, {...baseline, walletFlagged: true, walletAgeDays: 5});
    expect(flagged.reasons.map((r) => r.rule)).toContain("wallet.flagged");
    expect(flagged.reasons.map((r) => r.rule)).not.toContain("wallet.age.lt_30d");
  });

  it("score is capped at 100", () => {
    const s = engine.score(VENDOR, {
      verificationLevel: 0,
      vendorStatus: "active",
      registryAgeDays: 1,
      walletFlagged: true,
      phishingReports: 10,
      securityIncidents: 5,
      refundComplaints: 10,
      metadataIntegrity: "hash_mismatch",
    });
    expect(s.score).toBe(100);
    expect(s.riskLevel).toBe("critical");
  });
});
