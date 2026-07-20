import {
  canonicalBytes,
  hashDocument,
  toIpfsUri,
  validateMerchantMetadata,
  verifyCid,
  type MerchantMetadata,
} from "@actp/core";
import type {Hex} from "viem";
import type {Db} from "../db/client.js";
import type {IpfsStore} from "../storage/ipfs.js";

export type IntegrityStatus =
  | "verified" // document hash equals the hash anchored onchain
  | "hash_mismatch" // a document exists but does NOT match the anchor — treat as untrusted
  | "not_anchored" // document stored offchain, no (matching) anchor version yet
  | "no_document"; // nothing published

export interface StoredMetadata {
  vendorId: string;
  version: number;
  document: MerchantMetadata;
  canonicalHash: Hex;
  /** IPFS CID of the canonical document — the recommended onchain metadataURI (ipfs://<cid>). */
  cid: string | null;
  /** Whether the document is currently retrievable from the content-addressed store. */
  ipfsAvailable: boolean;
  createdAt: string;
  integrity: IntegrityStatus;
}

/**
 * ACTP V3 — versioned merchant metadata with onchain integrity anchoring.
 *
 * Flow: publish document here (validated + canonicalized + hashed) -> vendor owner anchors
 * the returned hash via VendorRegistry.setMetadata -> integrity becomes "verified" once the
 * indexer sees the anchor. Reads always recompute the hash; the database is trusted for
 * availability, never for integrity.
 */
export class MetadataService {
  constructor(
    private readonly db: Db,
    private readonly ipfs: IpfsStore,
  ) {}

  async publish(
    vendorId: string,
    rawDoc: unknown,
  ): Promise<{version: number; canonicalHash: Hex; cid: string; uri: string}> {
    const id = vendorId.toLowerCase();
    const doc = validateMerchantMetadata(rawDoc);

    const vendor = await this.db.query<{primary_domain: string; status: string}>(
      `SELECT primary_domain, status FROM vendors WHERE vendor_id = $1`,
      [id],
    );
    const v = vendor.rows[0];
    if (!v) throw new HttpError(404, "vendor not found");
    if (v.status === "revoked") throw new HttpError(409, "vendor is revoked");
    if (doc.primaryDomain !== v.primary_domain) {
      throw new HttpError(422, `document primaryDomain (${doc.primaryDomain}) does not match registry (${v.primary_domain})`);
    }

    // The keccak anchor and the CID cover the SAME canonical bytes, so both commitments
    // describe identical content.
    const bytes = canonicalBytes(doc);
    const canonicalHash = hashDocument(doc);
    const {cid} = await this.ipfs.put(bytes);

    return this.db.tx(async (q) => {
      const last = await q<{version: string | number}>(
        `SELECT coalesce(max(version), 0) AS version FROM metadata_documents WHERE vendor_id = $1`,
        [id],
      );
      const version = Number(last.rows[0]?.version ?? 0) + 1;
      await q(
        `INSERT INTO metadata_documents (vendor_id, version, document, canonical_hash, cid) VALUES ($1,$2,$3,$4,$5)`,
        [id, version, JSON.stringify(doc), canonicalHash, cid],
      );
      return {version, canonicalHash, cid, uri: toIpfsUri(cid)};
    });
  }

  async getLatest(vendorId: string): Promise<StoredMetadata | null> {
    const id = vendorId.toLowerCase();
    const res = await this.db.query<{
      version: string | number;
      document: unknown;
      canonical_hash: string;
      cid: string | null;
      created_at: string | Date;
    }>(
      `SELECT version, document, canonical_hash, cid, created_at FROM metadata_documents
       WHERE vendor_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;

    const document = (typeof row.document === "string" ? JSON.parse(row.document) : row.document) as MerchantMetadata;

    // Integrity is recomputed on every read — never trusted from storage.
    const recomputed = hashDocument(document);
    const anchored = await this.db.query<{metadata_hash: string | null}>(
      `SELECT metadata_hash FROM vendors WHERE vendor_id = $1`,
      [id],
    );
    const anchorHash = anchored.rows[0]?.metadata_hash?.toLowerCase() ?? null;

    let integrity: IntegrityStatus;
    if (recomputed.toLowerCase() !== row.canonical_hash.toLowerCase()) {
      integrity = "hash_mismatch"; // storage tampered with
    } else if (!anchorHash) {
      integrity = "not_anchored";
    } else if (anchorHash === recomputed.toLowerCase()) {
      integrity = "verified";
    } else {
      // an anchor exists but for a different version/hash: check whether it matches ANY stored version
      const match = await this.db.query<{version: string | number}>(
        `SELECT version FROM metadata_documents WHERE vendor_id = $1 AND canonical_hash = $2`,
        [id, anchorHash],
      );
      integrity = match.rows.length > 0 ? "not_anchored" : "hash_mismatch";
    }

    // Availability: fetch the block back from the content-addressed store and confirm it
    // still verifies against the recorded CID. This is what "the backend disappearing no
    // longer means unverifiable" buys us — the check is against IPFS, not our table.
    let ipfsAvailable = false;
    if (row.cid) {
      const fetched = await this.ipfs.get(row.cid).catch(() => null);
      ipfsAvailable = fetched !== null && (await verifyCid(fetched, row.cid));
    }

    return {
      vendorId: id,
      version: Number(row.version),
      document,
      canonicalHash: recomputed,
      cid: row.cid,
      ipfsAvailable,
      createdAt: new Date(row.created_at).toISOString(),
      integrity,
    };
  }

  /** Integrity summary used by the risk engine. */
  async integrityStatus(vendorId: string): Promise<IntegrityStatus> {
    const latest = await this.getLatest(vendorId);
    if (!latest) {
      const anchored = await this.db.query<{metadata_hash: string | null}>(
        `SELECT metadata_hash FROM vendors WHERE vendor_id = $1`,
        [vendorId.toLowerCase()],
      );
      return anchored.rows[0]?.metadata_hash ? "not_anchored" : "no_document";
    }
    return latest.integrity;
  }
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
