import {keccak256, toBytes, type Hex} from "viem";
import type {ContractTerms} from "@actp/core";
import type {Db} from "../../db/client.js";
import {HttpError} from "../metadata.js";
import type {ContractDocument, TermExtractor} from "./extractor.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export interface StoredTerms {
  vendorId: string;
  documentHash: Hex;
  terms: ContractTerms;
  extractor: string;
  extractorVersion: string;
  createdAt: string;
  /**
   * True only when the vendor owner anchored this exact terms hash onchain
   * (setContractMetadataHash). Everything else — AI or pattern extraction — is
   * information, never verified fact.
   */
  merchantAnchored: boolean;
}

/** ACTP V4 — contract intelligence pipeline: store document -> extract -> persist with provenance. */
export class ContractIntelService {
  constructor(
    private readonly db: Db,
    private readonly extractor: TermExtractor,
  ) {}

  async ingestDocument(
    vendorId: string,
    input: {content: string; docType: ContractDocument["docType"]; sourceUrl?: string},
  ): Promise<StoredTerms> {
    const id = vendorId.toLowerCase();
    if (Buffer.byteLength(input.content, "utf8") > MAX_DOCUMENT_BYTES) {
      throw new HttpError(413, "document exceeds 2 MiB");
    }
    if (input.content.trim().length === 0) throw new HttpError(422, "document is empty");

    const vendor = await this.db.query<{vendor_id: string}>(
      `SELECT vendor_id FROM vendors WHERE vendor_id = $1`,
      [id],
    );
    if (vendor.rows.length === 0) throw new HttpError(404, "vendor not found");

    const contentHash = keccak256(toBytes(input.content));

    await this.db.query(
      `INSERT INTO contract_documents (content_hash, vendor_id, doc_type, source_url, content)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (content_hash) DO NOTHING`,
      [contentHash, id, input.docType, input.sourceUrl ?? null, input.content],
    );

    const extracted = await this.extractor.extract({
      content: input.content,
      contentHash,
      docType: input.docType,
    });

    const terms: ContractTerms = {
      schema: "actp.contract-terms.v1",
      vendorId: id as Hex,
      ...extracted,
    };

    await this.db.query(
      `INSERT INTO contract_terms (vendor_id, document_hash, terms, extractor, extractor_version)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, contentHash, JSON.stringify(terms), this.extractor.name, this.extractor.version],
    );

    return this.decorate(id, contentHash, terms, this.extractor.name, this.extractor.version, new Date());
  }

  async getLatestTerms(vendorId: string): Promise<StoredTerms | null> {
    const id = vendorId.toLowerCase();
    const res = await this.db.query<{
      document_hash: string;
      terms: unknown;
      extractor: string;
      extractor_version: string;
      created_at: string | Date;
    }>(
      `SELECT document_hash, terms, extractor, extractor_version, created_at
       FROM contract_terms WHERE vendor_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    const terms = (typeof row.terms === "string" ? JSON.parse(row.terms) : row.terms) as ContractTerms;
    return this.decorate(
      id,
      row.document_hash as Hex,
      terms,
      row.extractor,
      row.extractor_version,
      new Date(row.created_at),
    );
  }

  private async decorate(
    vendorId: string,
    documentHash: Hex,
    terms: ContractTerms,
    extractor: string,
    extractorVersion: string,
    createdAt: Date,
  ): Promise<StoredTerms> {
    // merchant-anchored only if the vendor owner anchored this exact document hash onchain
    const anchored = await this.db.query<{contract_metadata_hash: string | null}>(
      `SELECT contract_metadata_hash FROM vendors WHERE vendor_id = $1`,
      [vendorId],
    );
    const merchantAnchored =
      anchored.rows[0]?.contract_metadata_hash?.toLowerCase() === documentHash.toLowerCase();

    return {
      vendorId,
      documentHash,
      terms,
      extractor,
      extractorVersion,
      createdAt: createdAt.toISOString(),
      merchantAnchored,
    };
  }
}
