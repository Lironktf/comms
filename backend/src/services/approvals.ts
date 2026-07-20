import {randomUUID} from "node:crypto";
import type {Money} from "@actp/core";
import type {Db} from "../db/client.js";
import {HttpError} from "./metadata.js";

/**
 * ACTP V8 — human-approval persistence.
 *
 * A REQUIRE_APPROVAL decision parks a pending approval carrying the token payload to mint on
 * grant and a context snapshot for the approver. Timeouts expire it (fail closed). This layer
 * is pure persistence; the DecisionService orchestrates grant (budget hold + token mint).
 */

export interface StoredTokenPayload {
  decisionId: string;
  principal: string;
  rail: string;
  payee: Record<string, unknown>;
  maxAmount: string;
  currency: string;
  vendorId: string | null;
}

export interface Approval {
  id: string;
  decisionId: string;
  principalId: string;
  orgId: string;
  status: "pending" | "approved" | "denied" | "expired";
  amount: Money;
  context: Record<string, unknown>;
  tokenPayload: StoredTokenPayload;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolver: string | null;
  reason: string | null;
}

interface ApprovalRow {
  id: string;
  decision_id: string;
  principal_id: string;
  org_id: string;
  status: Approval["status"];
  amount: unknown;
  context: unknown;
  token_payload: unknown;
  requested_at: string | Date;
  expires_at: string | Date;
  resolved_at: string | Date | null;
  resolver: string | null;
  reason: string | null;
}

export class ApprovalService {
  constructor(private readonly db: Db) {}

  async create(input: {
    decisionId: string;
    principalId: string;
    orgId: string;
    amount: Money;
    context: Record<string, unknown>;
    tokenPayload: StoredTokenPayload;
    ttlSeconds: number;
    now?: Date;
  }): Promise<Approval> {
    const now = input.now ?? new Date();
    const id = `apr_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    await this.db.query(
      `INSERT INTO approvals (id, decision_id, principal_id, org_id, status, amount, context, token_payload, expires_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)`,
      [
        id,
        input.decisionId,
        input.principalId,
        input.orgId,
        JSON.stringify(input.amount),
        JSON.stringify(input.context),
        JSON.stringify(input.tokenPayload),
        expiresAt,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Approval | null> {
    const res = await this.db.query<ApprovalRow>(`SELECT * FROM approvals WHERE id = $1`, [id]);
    const r = res.rows[0];
    return r ? this.map(r) : null;
  }

  /** Load a pending approval, expiring it lazily if past its TTL (fail closed). */
  async getActionable(id: string, now = new Date()): Promise<Approval> {
    const approval = await this.get(id);
    if (!approval) throw new HttpError(404, "approval not found");
    if (approval.status !== "pending") throw new HttpError(409, `approval already ${approval.status}`);
    if (new Date(approval.expiresAt) <= now) {
      await this.markResolved(id, "expired", "system", "expired before resolution", now);
      throw new HttpError(409, "approval expired");
    }
    return approval;
  }

  async markResolved(
    id: string,
    status: "approved" | "denied" | "expired",
    resolver: string,
    reason: string | null,
    now = new Date(),
  ): Promise<void> {
    await this.db.query(
      `UPDATE approvals SET status = $2, resolver = $3, reason = $4, resolved_at = $5 WHERE id = $1`,
      [id, status, resolver, reason, now],
    );
  }

  async listPending(orgId: string, now = new Date()): Promise<Approval[]> {
    const res = await this.db.query<ApprovalRow>(
      `SELECT * FROM approvals WHERE org_id = $1 AND status = 'pending' ORDER BY requested_at ASC`,
      [orgId],
    );
    return res.rows.map((r) => this.map(r)).filter((a) => new Date(a.expiresAt) > now);
  }

  private map(r: ApprovalRow): Approval {
    const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
    return {
      id: r.id,
      decisionId: r.decision_id,
      principalId: r.principal_id,
      orgId: r.org_id,
      status: r.status,
      amount: parse<Money>(r.amount),
      context: parse<Record<string, unknown>>(r.context),
      tokenPayload: parse<StoredTokenPayload>(r.token_payload),
      requestedAt: new Date(r.requested_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      resolver: r.resolver,
      reason: r.reason,
    };
  }
}
