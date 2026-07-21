import {randomUUID} from "node:crypto";
import type {Hex} from "viem";
import type {Db} from "../../db/client.js";
import {HttpError} from "../metadata.js";
import type {KybProvider, KybResult} from "./provider.js";

export interface KybCheckRecord extends KybResult {
  vendorId: string;
  /** what a verifier would submit onchain to grant level 3 on a passed check */
  attestationInput: {vendorId: string; attType: 3; evidenceHash: Hex} | null;
}

export class KybService {
  constructor(
    private readonly db: Db,
    private readonly provider: KybProvider,
  ) {}

  async run(
    vendorId: string,
    business: {legalName?: string; registrationId?: string; jurisdiction?: string},
  ): Promise<KybCheckRecord> {
    const id = vendorId.toLowerCase();
    const vendor = await this.db.query(`SELECT 1 FROM vendors WHERE vendor_id = $1`, [id]);
    if (vendor.rows.length === 0) throw new HttpError(404, "vendor not found");

    const result = await this.provider.verify({vendorId: id, ...business});
    await this.db.query(
      `INSERT INTO kyb_checks (id, vendor_id, passed, provider, legal_name, registration_id, jurisdiction, evidence_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        `kyb_${randomUUID().slice(0, 12)}`,
        id,
        result.passed,
        result.provider,
        result.legalName,
        result.registrationId,
        result.jurisdiction,
        result.evidenceHash,
        JSON.stringify(result.detail),
      ],
    );
    return this.decorate(id, result);
  }

  async latest(vendorId: string): Promise<KybCheckRecord | null> {
    const res = await this.db.query<{
      passed: boolean;
      provider: string;
      legal_name: string | null;
      registration_id: string | null;
      jurisdiction: string | null;
      evidence_hash: string;
      detail: unknown;
      checked_at: string | Date;
    }>(
      `SELECT * FROM kyb_checks WHERE vendor_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [vendorId.toLowerCase()],
    );
    const r = res.rows[0];
    if (!r) return null;
    return this.decorate(vendorId.toLowerCase(), {
      passed: r.passed,
      provider: r.provider,
      legalName: r.legal_name,
      registrationId: r.registration_id,
      jurisdiction: r.jurisdiction,
      evidenceHash: r.evidence_hash as Hex,
      detail: (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
      checkedAt: new Date(r.checked_at).toISOString(),
    });
  }

  private decorate(vendorId: string, result: KybResult): KybCheckRecord {
    return {
      ...result,
      vendorId,
      attestationInput: result.passed
        ? {vendorId, attType: 3, evidenceHash: result.evidenceHash}
        : null,
    };
  }
}
