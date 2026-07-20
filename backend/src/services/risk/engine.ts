import {canonicalize, type RiskLevel, type RiskScore, type RiskSignals} from "@actp/core";
import {keccak256, toBytes, type Hex} from "viem";
import type {Db} from "../../db/client.js";
import type {MetadataService} from "../metadata.js";
import type {VendorService} from "../vendors.js";
import {HttpError} from "../metadata.js";
import {RULESET_V1, type Ruleset} from "./ruleset.js";

/**
 * ACTP V5 — risk engine.
 *
 * Pure core (`score`): signals + ruleset -> RiskScore. Deterministic and reproducible —
 * the emitted `inputsSnapshotHash` is the keccak256 of the canonicalized signals, so any
 * consumer can re-run the ruleset over the same snapshot and get the identical result.
 *
 * Shell (`evaluateVendor`): assembles signals from the indexed registry state, stored
 * risk signals, and metadata integrity, then scores and persists.
 */
export class RiskEngine {
  constructor(
    private readonly db: Db,
    private readonly vendors: VendorService,
    private readonly metadata: MetadataService,
    private readonly ruleset: Ruleset = RULESET_V1,
  ) {}

  /** Pure scoring: no I/O, no clock beyond the passed timestamp. */
  score(vendorId: string, signals: RiskSignals, evaluatedAt: Date = new Date()): RiskScore {
    const {results, overrides} = this.ruleset.evaluate(signals);

    let total = results.reduce((sum, r) => sum + r.weight, 0);
    let forcedLevel: RiskLevel | null = null;
    for (const o of overrides) {
      total = Math.max(total, o.minScore);
      // strongest override wins: critical > high > medium > low
      if (!forcedLevel || LEVEL_ORDER[o.forceLevel] > LEVEL_ORDER[forcedLevel]) {
        forcedLevel = o.forceLevel;
      }
    }
    const score = Math.min(100, total);

    const {low, medium, high} = this.ruleset.levelBounds;
    const computedLevel: RiskLevel =
      score < low ? "low" : score < medium ? "medium" : score < high ? "high" : "critical";
    const riskLevel = forcedLevel && LEVEL_ORDER[forcedLevel] > LEVEL_ORDER[computedLevel]
      ? forcedLevel
      : computedLevel;

    const reasons = [...overrides.map(({rule, weight, evidence}) => ({rule, weight, evidence})), ...results]
      .sort((a, b) => b.weight - a.weight || a.rule.localeCompare(b.rule));

    return {
      vendorId: vendorId.toLowerCase() as Hex,
      riskLevel,
      score,
      reasons,
      rulesetVersion: this.ruleset.version,
      evaluatedAt: evaluatedAt.toISOString(),
      inputsSnapshotHash: keccak256(toBytes(canonicalize(signals))),
    };
  }

  /** Assemble signals for a vendor from indexed state + stored external signals. */
  async assembleSignals(vendorId: string, now = new Date()): Promise<RiskSignals> {
    const id = vendorId.toLowerCase();
    const vendor = await this.vendors.getVendor(id);
    if (!vendor) throw new HttpError(404, "vendor not found");

    const stored = await this.db.query<{signal: string; value: unknown}>(
      `SELECT signal, value FROM risk_signals WHERE vendor_id = $1`,
      [id],
    );
    const ext: Record<string, unknown> = {};
    for (const row of stored.rows) {
      ext[row.signal] = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    }

    const registryAgeDays = Math.floor(
      (now.getTime() - new Date(vendor.registeredAt).getTime()) / 86_400_000,
    );

    const signals: RiskSignals = {
      verificationLevel: vendor.verificationLevel,
      vendorStatus: vendor.status,
      registryAgeDays,
      metadataIntegrity: await this.metadata.integrityStatus(id),
      expiredAttestations: await this.vendors.expiredAttestationCount(id, now),
    };

    if (typeof ext.domain_age_days === "number") signals.domainAgeDays = ext.domain_age_days;
    if (typeof ext.wallet_age_days === "number") signals.walletAgeDays = ext.wallet_age_days;
    if (typeof ext.wallet_flagged === "boolean") signals.walletFlagged = ext.wallet_flagged;
    if (typeof ext.sanctions_match === "boolean") signals.sanctionsMatch = ext.sanctions_match;
    if (typeof ext.phishing_reports === "number") signals.phishingReports = ext.phishing_reports;
    if (typeof ext.security_incidents === "number") signals.securityIncidents = ext.security_incidents;
    if (typeof ext.refund_complaints === "number") signals.refundComplaints = ext.refund_complaints;

    return signals;
  }

  /** Full evaluation: assemble -> score -> persist history row. */
  async evaluateVendor(vendorId: string, now = new Date()): Promise<RiskScore> {
    const signals = await this.assembleSignals(vendorId, now);
    const result = this.score(vendorId, signals, now);
    await this.db.query(
      `INSERT INTO risk_scores (vendor_id, risk_level, score, reasons, ruleset_version, inputs_snapshot_hash, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        result.vendorId,
        result.riskLevel,
        result.score,
        JSON.stringify(result.reasons),
        result.rulesetVersion,
        result.inputsSnapshotHash,
        new Date(result.evaluatedAt),
      ],
    );
    return result;
  }

  /** Record an externally observed signal (sanctions, phishing, domain age, ...). */
  async upsertSignal(vendorId: string, signal: string, value: unknown, source: string): Promise<void> {
    if (!/^[a-z0-9_]{1,64}$/.test(signal)) throw new HttpError(422, "invalid signal name");
    await this.db.query(
      `INSERT INTO risk_signals (vendor_id, signal, value, source, observed_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (vendor_id, signal) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, observed_at = now()`,
      [vendorId.toLowerCase(), signal, JSON.stringify(value), source],
    );
  }

  async history(vendorId: string, limit = 20): Promise<RiskScore[]> {
    const res = await this.db.query<{
      vendor_id: string;
      risk_level: RiskLevel;
      score: number;
      reasons: unknown;
      ruleset_version: string;
      inputs_snapshot_hash: string;
      evaluated_at: string | Date;
    }>(
      `SELECT * FROM risk_scores WHERE vendor_id = $1 ORDER BY id DESC LIMIT $2`,
      [vendorId.toLowerCase(), Math.min(limit, 100)],
    );
    return res.rows.map((r) => ({
      vendorId: r.vendor_id as Hex,
      riskLevel: r.risk_level,
      score: r.score,
      reasons: (typeof r.reasons === "string" ? JSON.parse(r.reasons) : r.reasons) as RiskScore["reasons"],
      rulesetVersion: r.ruleset_version,
      evaluatedAt: new Date(r.evaluated_at).toISOString(),
      inputsSnapshotHash: r.inputs_snapshot_hash as Hex,
    }));
  }
}

const LEVEL_ORDER: Record<RiskLevel, number> = {low: 0, medium: 1, high: 2, critical: 3};
