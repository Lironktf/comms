import {randomUUID} from "node:crypto";
import {canonicalize, type Receipt, type ReceiptEvent} from "@actp/core";
import {keccak256, toBytes, type Hex} from "viem";
import type {Db} from "../db/client.js";

const GENESIS: Hex = `0x${"00".repeat(32)}`;

/**
 * ACTP V13 — tamper-evident receipt chain.
 *
 * Every decision, approval, and settlement is appended to a per-org hash chain:
 *   hash_n = keccak256( hash_{n-1} ‖ canonical(payload) ‖ n )
 * Any edit or deletion of a past receipt breaks every subsequent hash, so the full audit
 * trail — intent → authorization → settlement, across every rail — is verifiable end to end.
 * (A future stage anchors periodic Merkle roots onchain; the chain itself is the MVP.)
 */
export class ReceiptService {
  constructor(private readonly db: Db) {}

  async append(orgId: string, event: ReceiptEvent, payload: Record<string, unknown>): Promise<Receipt> {
    return this.db.tx(async (q) => {
      const last = await q<{seq: string | number; hash: string}>(
        `SELECT seq, hash FROM receipts WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`,
        [orgId],
      );
      const prevSeq = last.rows[0] ? Number(last.rows[0].seq) : 0;
      const prevHash = (last.rows[0]?.hash as Hex) ?? GENESIS;
      const seq = prevSeq + 1;
      const hash = hashLink(prevHash, payload, seq);
      const id = `rcpt_${randomUUID().slice(0, 12)}`;
      await q(
        `INSERT INTO receipts (id, org_id, seq, prev_hash, event, payload, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, orgId, seq, prevHash, event, JSON.stringify(payload), hash],
      );
      return {
        receiptId: id,
        seq,
        orgId,
        event,
        hash,
        prevHash,
        payload,
        createdAt: new Date().toISOString(),
      };
    });
  }

  async list(orgId: string, limit = 50): Promise<Receipt[]> {
    const res = await this.db.query<ReceiptRow>(
      `SELECT * FROM receipts WHERE org_id = $1 ORDER BY seq DESC LIMIT $2`,
      [orgId, Math.min(limit, 500)],
    );
    return res.rows.map(mapReceipt);
  }

  /** Recompute the whole chain and confirm continuity + hash integrity. */
  async verifyChain(orgId: string): Promise<{valid: boolean; length: number; brokenAtSeq: number | null}> {
    const res = await this.db.query<ReceiptRow>(
      `SELECT * FROM receipts WHERE org_id = $1 ORDER BY seq ASC`,
      [orgId],
    );
    let prevHash: Hex = GENESIS;
    let expectedSeq = 1;
    for (const row of res.rows) {
      const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
      if (Number(row.seq) !== expectedSeq) return {valid: false, length: res.rows.length, brokenAtSeq: Number(row.seq)};
      if (row.prev_hash.toLowerCase() !== prevHash.toLowerCase()) {
        return {valid: false, length: res.rows.length, brokenAtSeq: Number(row.seq)};
      }
      const recomputed = hashLink(prevHash, payload, expectedSeq);
      if (recomputed.toLowerCase() !== row.hash.toLowerCase()) {
        return {valid: false, length: res.rows.length, brokenAtSeq: Number(row.seq)};
      }
      prevHash = row.hash as Hex;
      expectedSeq++;
    }
    return {valid: true, length: res.rows.length, brokenAtSeq: null};
  }
}

interface ReceiptRow {
  id: string;
  org_id: string;
  seq: string | number;
  prev_hash: string;
  event: ReceiptEvent;
  payload: unknown;
  hash: string;
  created_at: string | Date;
}

function mapReceipt(r: ReceiptRow): Receipt {
  return {
    receiptId: r.id,
    seq: Number(r.seq),
    orgId: r.org_id,
    event: r.event,
    hash: r.hash as Hex,
    prevHash: r.prev_hash as Hex,
    payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function hashLink(prevHash: Hex, payload: Record<string, unknown>, seq: number): Hex {
  return keccak256(toBytes(`${prevHash}.${canonicalize(payload)}.${seq}`));
}
