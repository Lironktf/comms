import type {Hex} from "viem";
import type {Db} from "../db/client.js";
import {VendorService} from "./vendors.js";
import {RiskEngine} from "./risk/engine.js";
import {ReputationService} from "./reputation.js";

/**
 * ACTP V14 — trusted merchant discovery.
 *
 * Instead of an agent searching the open web (and finding fraudulent lookalikes), it queries
 * the registry for merchants that are verified, low-risk, and — optionally — in a category.
 * Ranking is deterministic and explained: verification level, then inverse risk, then
 * reputation. There is deliberately **no pay-for-placement** input; the moment ranking can be
 * bought, the registry's neutrality (its entire value) is gone.
 */
export interface DiscoveryQuery {
  category?: string;
  minVerificationLevel?: number;
  maxRiskScore?: number;
  limit?: number;
}

export interface DiscoveryResult {
  vendorId: Hex;
  primaryDomain: string;
  verificationLevel: number;
  riskLevel: string;
  riskScore: number;
  reputationScore: number | null;
  rank: number;
  rankBasis: {verificationLevel: number; riskScore: number; reputationScore: number | null};
}

export class DiscoveryService {
  constructor(
    private readonly db: Db,
    private readonly vendors: VendorService,
    private readonly risk: RiskEngine,
    private readonly reputation: ReputationService,
  ) {}

  async search(query: DiscoveryQuery, now = new Date()): Promise<DiscoveryResult[]> {
    const minLevel = query.minVerificationLevel ?? 1;
    const maxRisk = query.maxRiskScore ?? 100;
    const limit = Math.min(query.limit ?? 25, 100);

    // candidate active vendors, optionally filtered by declared category in metadata
    const candidates = await this.candidateVendorIds(query.category);

    const results: DiscoveryResult[] = [];
    for (const vendorId of candidates) {
      const vendor = await this.vendors.getVendor(vendorId);
      if (!vendor || vendor.status !== "active") continue;
      if (vendor.verificationLevel < minLevel) continue;

      const signals = await this.risk.assembleSignals(vendorId, now);
      const scored = this.risk.score(vendorId, signals, now);
      if (scored.score > maxRisk) continue;

      const rep = await this.reputation.forVendor(vendorId);
      results.push({
        vendorId: vendor.vendorId,
        primaryDomain: vendor.primaryDomain,
        verificationLevel: vendor.verificationLevel,
        riskLevel: scored.riskLevel,
        riskScore: scored.score,
        reputationScore: rep.score,
        rank: 0,
        rankBasis: {verificationLevel: vendor.verificationLevel, riskScore: scored.score, reputationScore: rep.score},
      });
    }

    // deterministic rank: higher verification, then lower risk, then higher reputation, then domain
    results.sort(
      (a, b) =>
        b.verificationLevel - a.verificationLevel ||
        a.riskScore - b.riskScore ||
        (b.reputationScore ?? -1) - (a.reputationScore ?? -1) ||
        a.primaryDomain.localeCompare(b.primaryDomain),
    );
    results.forEach((r, i) => (r.rank = i + 1));
    return results.slice(0, limit);
  }

  private async candidateVendorIds(category?: string): Promise<string[]> {
    if (category) {
      // vendors whose latest published metadata declares the category
      const res = await this.db.query<{vendor_id: string}>(
        `SELECT DISTINCT vendor_id FROM metadata_documents
         WHERE document::text LIKE $1`,
        [`%"${category}"%`],
      );
      return res.rows.map((r) => r.vendor_id);
    }
    const res = await this.db.query<{vendor_id: string}>(
      `SELECT vendor_id FROM vendors WHERE status = 'active' ORDER BY registered_at DESC LIMIT 500`,
    );
    return res.rows.map((r) => r.vendor_id);
  }
}
