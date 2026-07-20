import type {Hex} from "viem";
import {AttestationType, type AttestationRecord, type VendorRecord} from "@actp/core";
import type {Db} from "../db/client.js";

interface VendorRow {
  vendor_id: string;
  owner: string;
  status: "active" | "suspended" | "revoked";
  primary_domain: string;
  x402_endpoint: string | null;
  metadata_hash: string | null;
  metadata_uri: string | null;
  metadata_version: string | number;
  contract_metadata_hash: string | null;
  contract_metadata_version: string | number;
  registered_at: string | Date;
  updated_at: string | Date;
}

interface AttestationRow {
  attestation_id: string;
  vendor_id: string;
  att_type: number;
  evidence_hash: string;
  issued_at: string | Date;
  expires_at: string | Date;
  attester: string;
  revoked: boolean;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

export class VendorService {
  constructor(private readonly db: Db) {}

  async getVendor(vendorId: string): Promise<VendorRecord | null> {
    const id = vendorId.toLowerCase();
    const res = await this.db.query<VendorRow>(`SELECT * FROM vendors WHERE vendor_id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return null;

    const [domains, wallets, level] = await Promise.all([
      this.db.query<{domain: string}>(`SELECT domain FROM vendor_domains WHERE vendor_id = $1 ORDER BY domain`, [id]),
      this.db.query<{wallet: string}>(`SELECT wallet FROM vendor_wallets WHERE vendor_id = $1 ORDER BY wallet`, [id]),
      this.verificationLevel(id),
    ]);

    return {
      vendorId: row.vendor_id as Hex,
      owner: row.owner as Hex,
      status: row.status,
      primaryDomain: row.primary_domain,
      domains: domains.rows.map((d) => d.domain),
      wallets: wallets.rows.map((w) => w.wallet as Hex),
      x402Endpoint: row.x402_endpoint,
      metadataHash: (row.metadata_hash as Hex) ?? null,
      metadataUri: row.metadata_uri,
      metadataVersion: Number(row.metadata_version),
      contractMetadataHash: (row.contract_metadata_hash as Hex) ?? null,
      contractMetadataVersion: Number(row.contract_metadata_version),
      verificationLevel: level,
      registeredAt: iso(row.registered_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async resolveByDomain(domain: string): Promise<string | null> {
    const res = await this.db.query<{vendor_id: string}>(
      `SELECT vendor_id FROM vendor_domains WHERE domain = $1`,
      [domain.toLowerCase()],
    );
    return res.rows[0]?.vendor_id ?? null;
  }

  async resolveByWallet(wallet: string): Promise<string | null> {
    const res = await this.db.query<{vendor_id: string}>(
      `SELECT vendor_id FROM vendor_wallets WHERE wallet = $1`,
      [wallet.toLowerCase()],
    );
    return res.rows[0]?.vendor_id ?? null;
  }

  async listVendors(limit = 50, offset = 0): Promise<{vendorId: string; primaryDomain: string; status: string}[]> {
    const res = await this.db.query<VendorRow>(
      `SELECT vendor_id, primary_domain, status, owner, x402_endpoint, metadata_hash, metadata_uri,
              metadata_version, contract_metadata_hash, contract_metadata_version, registered_at, updated_at
       FROM vendors ORDER BY registered_at DESC LIMIT $1 OFFSET $2`,
      [Math.min(limit, 200), offset],
    );
    return res.rows.map((r) => ({vendorId: r.vendor_id, primaryDomain: r.primary_domain, status: r.status}));
  }

  async getAttestations(vendorId: string): Promise<AttestationRecord[]> {
    const id = vendorId.toLowerCase();
    const res = await this.db.query<AttestationRow>(
      `SELECT * FROM attestations WHERE vendor_id = $1 ORDER BY issued_at DESC`,
      [id],
    );
    const out: AttestationRecord[] = [];
    for (const row of res.rows) {
      out.push({
        attestationId: row.attestation_id as Hex,
        vendorId: row.vendor_id as Hex,
        attType: row.att_type as AttestationType,
        evidenceHash: row.evidence_hash as Hex,
        issuedAt: iso(row.issued_at),
        expiresAt: iso(row.expires_at),
        attester: row.attester as Hex,
        revoked: row.revoked,
        active: await this.isAttestationActive(row),
      });
    }
    return out;
  }

  /**
   * Mirror of AttestationRegistry.isAttestationActive: unrevoked, unexpired, issuer not
   * banned for the issuance window, vendor Active, and for VendorSigned the evidence hash
   * must equal the currently anchored metadata hash.
   */
  private async isAttestationActive(row: AttestationRow, now = new Date()): Promise<boolean> {
    if (row.revoked) return false;
    if (new Date(row.expires_at) <= now) return false;

    const ban = await this.db.query<{issued_at_cutoff: string | Date}>(
      `SELECT issued_at_cutoff FROM attester_bans WHERE attester = $1`,
      [row.attester.toLowerCase()],
    );
    const cutoffRow = ban.rows[0];
    if (cutoffRow && new Date(row.issued_at) <= new Date(cutoffRow.issued_at_cutoff)) return false;

    const vendor = await this.db.query<{status: string; metadata_hash: string | null}>(
      `SELECT status, metadata_hash FROM vendors WHERE vendor_id = $1`,
      [row.vendor_id],
    );
    const v = vendor.rows[0];
    if (!v || v.status !== "active") return false;
    if (row.att_type === AttestationType.VendorSigned && v.metadata_hash?.toLowerCase() !== row.evidence_hash.toLowerCase()) {
      return false;
    }
    return true;
  }

  /** Highest attestation type whose most recent attestation is active (contract parity). */
  async verificationLevel(vendorId: string, now = new Date()): Promise<number> {
    const id = vendorId.toLowerCase();
    for (let t = AttestationType.Audited; t >= AttestationType.DomainVerified; t--) {
      const res = await this.db.query<AttestationRow>(
        `SELECT * FROM attestations WHERE vendor_id = $1 AND att_type = $2
         ORDER BY block_number DESC, issued_at DESC LIMIT 1`,
        [id, t],
      );
      const latest = res.rows[0];
      if (latest && (await this.isAttestationActive(latest, now))) return t;
    }
    return 0;
  }

  /** Count of attestations that lapsed without renewal — a V5 risk signal. */
  async expiredAttestationCount(vendorId: string, now = new Date()): Promise<number> {
    const res = await this.db.query<{n: string | number}>(
      `SELECT count(*) AS n FROM attestations WHERE vendor_id = $1 AND revoked = FALSE AND expires_at <= $2`,
      [vendorId.toLowerCase(), now],
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}
