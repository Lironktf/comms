import type {Hex} from "viem";
import type {Db} from "../db/client.js";

/**
 * ACTP V10 — merchant reputation, computed from the settlement corpus.
 *
 * Reputation is derived, never asserted — it is a function of real settled outcomes
 * (fulfilled / disputed / refunded / failed) reported against a vendor. Crucially it is
 * **verification-weighted**: feedback from a highly-verified buyer principal counts more than
 * from an unverified one, so the ERC-8004 failure mode (sybil agents rating each other to
 * manufacture reputation) is structurally damped rather than assumed away.
 *
 * It is kept strictly separate from the verified facts in the registry — a good reputation
 * never substitutes for verification level or a clean risk score.
 */
export interface Reputation {
  vendorId: Hex;
  /** weighted settlement counts */
  totalWeighted: number;
  fulfilledWeighted: number;
  disputedWeighted: number;
  refundedWeighted: number;
  failedWeighted: number;
  /** 0–100, weighted fulfillment rate; null when there is not enough signal */
  score: number | null;
  sampleSize: number;
}

const MIN_SAMPLE = 3;

// A settlement's weight rises with the reporting principal's verification level, so sybil
// feedback (level 0) barely moves the needle.
function weightForLevel(level: number): number {
  return 1 + Math.max(0, Math.min(level, 5)); // 1..6
}

export class ReputationService {
  constructor(private readonly db: Db) {}

  async forVendor(vendorId: string): Promise<Reputation> {
    const id = vendorId.toLowerCase();
    const res = await this.db.query<{outcome: string; verification_level: number}>(
      `SELECT outcome, verification_level FROM settlements WHERE vendor_id = $1`,
      [id],
    );

    let total = 0;
    let fulfilled = 0;
    let disputed = 0;
    let refunded = 0;
    let failed = 0;
    for (const s of res.rows) {
      const w = weightForLevel(Number(s.verification_level));
      total += w;
      if (s.outcome === "fulfilled") fulfilled += w;
      else if (s.outcome === "disputed") disputed += w;
      else if (s.outcome === "refunded") refunded += w;
      else if (s.outcome === "failed") failed += w;
    }

    const score = res.rows.length >= MIN_SAMPLE && total > 0 ? Math.round((fulfilled / total) * 100) : null;

    return {
      vendorId: id as Hex,
      totalWeighted: total,
      fulfilledWeighted: fulfilled,
      disputedWeighted: disputed,
      refundedWeighted: refunded,
      failedWeighted: failed,
      score,
      sampleSize: res.rows.length,
    };
  }
}
