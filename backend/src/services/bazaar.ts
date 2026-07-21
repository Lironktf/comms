import {randomUUID} from "node:crypto";
import type {Hex} from "viem";
import type {Db} from "../db/client.js";
import {VendorService} from "./vendors.js";
import {RiskEngine} from "./risk/engine.js";
import {ReputationService} from "./reputation.js";

/**
 * Vetted Bazaar (ACTP V14, applied to x402 discovery).
 *
 * x402's Bazaar lists thousands of paid tools with zero vetting — the July-2026 wash-trading
 * findings show how much of that is synthetic. This turns the raw feed into a *trusted* one:
 * every listing's payout wallet / domain is resolved against the ACTP registry, scored for
 * verification + risk + reputation, and marked `eligibleForAgentPurchase` with reasons. An
 * agent queries this instead of the open Bazaar. Ranking is on merit only — there is no
 * pay-for-placement input, because a buyable ranking destroys the whole point.
 */

export interface BazaarListingInput {
  resourceUrl: string;
  payTo?: string;
  domain?: string;
  serviceName?: string;
  tags?: string[];
  price?: {amount: string; currency: string};
}

export interface VettedListing {
  resourceUrl: string;
  serviceName: string | null;
  tags: string[];
  price: {amount: string; currency: string} | null;
  vendorId: Hex | null;
  verificationLevel: number;
  vendorStatus: string;
  riskLevel: string;
  riskScore: number | null;
  reputationScore: number | null;
  eligibleForAgentPurchase: boolean;
  reasons: string[];
  rank: number;
}

export interface VetQuery {
  minVerificationLevel?: number;
  maxRiskScore?: number;
  tag?: string;
  eligibleOnly?: boolean;
  limit?: number;
}

export class BazaarService {
  constructor(
    private readonly db: Db,
    private readonly vendors: VendorService,
    private readonly risk: RiskEngine,
    private readonly reputation: ReputationService,
  ) {}

  async ingest(listings: BazaarListingInput[], source = "ingest"): Promise<{ingested: number}> {
    let n = 0;
    for (const l of listings) {
      if (!l.resourceUrl) continue;
      const id = `baz_${randomUUID().slice(0, 12)}`;
      await this.db.query(
        `INSERT INTO bazaar_listings (id, resource_url, pay_to, domain, service_name, tags, price, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          l.resourceUrl,
          l.payTo ? l.payTo.toLowerCase() : null,
          l.domain ? l.domain.toLowerCase() : hostOf(l.resourceUrl),
          l.serviceName ?? null,
          JSON.stringify(l.tags ?? []),
          l.price ? JSON.stringify(l.price) : null,
          source,
        ],
      );
      n++;
    }
    return {ingested: n};
  }

  /** The vetted, ranked feed. */
  async vetted(query: VetQuery = {}, now = new Date()): Promise<VettedListing[]> {
    const minLevel = query.minVerificationLevel ?? 0;
    const maxRisk = query.maxRiskScore ?? 100;
    const limit = Math.min(query.limit ?? 50, 200);

    const rows = await this.db.query<{
      resource_url: string;
      pay_to: string | null;
      domain: string | null;
      service_name: string | null;
      tags: unknown;
      price: unknown;
    }>(`SELECT * FROM bazaar_listings ORDER BY ingested_at DESC LIMIT 500`);

    const out: VettedListing[] = [];
    for (const r of rows.rows) {
      const tags = (typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags) as string[];
      if (query.tag && !tags.includes(query.tag)) continue;

      let vendorId: string | null = null;
      if (r.pay_to) vendorId = await this.vendors.resolveByWallet(r.pay_to);
      if (!vendorId && r.domain) vendorId = await this.vendors.resolveByDomain(r.domain);
      const vendor = vendorId ? await this.vendors.getVendor(vendorId) : null;

      const reasons: string[] = [];
      let riskLevel = "unknown";
      let riskScore: number | null = null;
      let reputationScore: number | null = null;

      if (vendor) {
        const signals = await this.risk.assembleSignals(vendor.vendorId, now);
        const scored = this.risk.score(vendor.vendorId, signals, now);
        riskLevel = scored.riskLevel;
        riskScore = scored.score;
        reputationScore = (await this.reputation.forVendor(vendor.vendorId)).score;
      } else {
        reasons.push("merchant.unregistered");
      }

      const level = vendor?.verificationLevel ?? 0;
      const status = vendor?.status ?? "unknown";
      let eligible = true;
      if (!vendor) eligible = false;
      if (status !== "active") {
        eligible = false;
        reasons.push(`merchant.status.${status}`);
      }
      if (level < minLevel) {
        eligible = false;
        reasons.push(`verification.below_min(${level}<${minLevel})`);
      }
      if (riskScore !== null && riskScore > maxRisk) {
        eligible = false;
        reasons.push(`risk.above_max(${riskScore}>${maxRisk})`);
      }
      if (eligible) reasons.push(`verified.level_${level}`, `risk.${riskLevel}`);

      if (query.eligibleOnly && !eligible) continue;

      out.push({
        resourceUrl: r.resource_url,
        serviceName: r.service_name,
        tags,
        price: (typeof r.price === "string" ? JSON.parse(r.price) : r.price) as VettedListing["price"],
        vendorId: (vendorId as Hex | null) ?? null,
        verificationLevel: level,
        vendorStatus: status,
        riskLevel,
        riskScore,
        reputationScore,
        eligibleForAgentPurchase: eligible,
        reasons,
        rank: 0,
      });
    }

    // rank: eligible first, then higher verification, lower risk, higher reputation, stable by url
    out.sort(
      (a, b) =>
        Number(b.eligibleForAgentPurchase) - Number(a.eligibleForAgentPurchase) ||
        b.verificationLevel - a.verificationLevel ||
        (a.riskScore ?? 101) - (b.riskScore ?? 101) ||
        (b.reputationScore ?? -1) - (a.reputationScore ?? -1) ||
        a.resourceUrl.localeCompare(b.resourceUrl),
    );
    out.forEach((l, i) => (l.rank = i + 1));
    return out.slice(0, limit);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
