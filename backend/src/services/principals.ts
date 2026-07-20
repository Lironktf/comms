import {randomUUID} from "node:crypto";
import type {DelegationConstraints, PolicyDocument, Rail} from "@actp/core";
import {parseAmount, gt, type Micros, validatePolicy} from "@actp/core";
import type {Hex} from "viem";
import type {Db} from "../db/client.js";
import {HttpError} from "./metadata.js";

/**
 * ACTP V7/V9 — principals (org → department → agent) and attenuated delegation.
 *
 * Delegation can only narrow: an agent's effective authority is the intersection of every
 * constraint along its chain to the org root. Policies attach to any principal; an agent
 * uses the nearest policy up its chain. This is the "one policy, many agents, safely sharing
 * one treasury" model — and it is rail-agnostic (constraints and budgets are in the org's
 * normalized currency, spanning card + stablecoin + A2A).
 */

export type PrincipalKind = "org" | "department" | "agent";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  parentId: string | null;
  orgId: string;
  displayName: string;
  status: "active" | "suspended";
  policyId: string | null;
  createdAt: string;
}

export interface EffectiveConstraints {
  maxAmountMicros: Micros | null;
  rails: Rail[] | null; // null = unrestricted
  categories: string[] | null;
  deniedVendors: Set<string>;
  allowedVendors: Set<string> | null;
  /** delegation ids that contributed, for explainability */
  sources: string[];
  expired: boolean;
}

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  parent_id: string | null;
  org_id: string;
  display_name: string;
  status: "active" | "suspended";
  policy_id: string | null;
  created_at: string | Date;
}

export class PrincipalService {
  constructor(private readonly db: Db) {}

  async createOrg(displayName: string): Promise<Principal> {
    const id = `org_${randomUUID().slice(0, 12)}`;
    return this.insert({id, kind: "org", parentId: null, orgId: id, displayName});
  }

  async createChild(
    parentId: string,
    kind: "department" | "agent",
    displayName: string,
  ): Promise<Principal> {
    const parent = await this.getPrincipal(parentId);
    if (!parent) throw new HttpError(404, "parent principal not found");
    if (kind === "department" && parent.kind === "agent") {
      throw new HttpError(422, "a department cannot be a child of an agent");
    }
    const prefix = kind === "department" ? "dept" : "agent";
    const id = `${prefix}_${randomUUID().slice(0, 12)}`;
    return this.insert({id, kind, parentId, orgId: parent.orgId, displayName});
  }

  private async insert(p: {
    id: string;
    kind: PrincipalKind;
    parentId: string | null;
    orgId: string;
    displayName: string;
  }): Promise<Principal> {
    await this.db.query(
      `INSERT INTO principals (id, kind, parent_id, org_id, display_name) VALUES ($1,$2,$3,$4,$5)`,
      [p.id, p.kind, p.parentId, p.orgId, p.displayName],
    );
    return (await this.getPrincipal(p.id))!;
  }

  async getPrincipal(id: string): Promise<Principal | null> {
    const res = await this.db.query<PrincipalRow>(`SELECT * FROM principals WHERE id = $1`, [id]);
    const r = res.rows[0];
    return r ? this.map(r) : null;
  }

  /** Ordered chain from the principal up to (and including) the org root. */
  async chain(id: string): Promise<Principal[]> {
    const out: Principal[] = [];
    let cur = await this.getPrincipal(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parentId ? await this.getPrincipal(cur.parentId) : null;
    }
    return out;
  }

  async setStatus(id: string, status: "active" | "suspended"): Promise<void> {
    const res = await this.db.query(`UPDATE principals SET status = $2 WHERE id = $1`, [id, status]);
    if (res.rowCount === 0) throw new HttpError(404, "principal not found");
  }

  // --- policies -----------------------------------------------------------

  async setPolicy(principalId: string, doc: PolicyDocument): Promise<{policyId: string}> {
    validatePolicy(doc);
    const principal = await this.getPrincipal(principalId);
    if (!principal) throw new HttpError(404, "principal not found");
    const policyId = `pol_${randomUUID().slice(0, 12)}`;
    await this.db.tx(async (q) => {
      await q(`INSERT INTO policies (id, principal_id, version, document) VALUES ($1,$2,$3,$4)`, [
        policyId,
        principalId,
        doc.version,
        JSON.stringify(doc),
      ]);
      await q(`UPDATE principals SET policy_id = $2 WHERE id = $1`, [principalId, policyId]);
    });
    return {policyId};
  }

  /** Nearest active policy walking up the chain from the agent. */
  async effectivePolicy(agentId: string): Promise<PolicyDocument | null> {
    const chain = await this.chain(agentId);
    for (const p of chain) {
      if (!p.policyId) continue;
      const res = await this.db.query<{document: unknown}>(
        `SELECT document FROM policies WHERE id = $1`,
        [p.policyId],
      );
      const row = res.rows[0];
      if (row) return (typeof row.document === "string" ? JSON.parse(row.document) : row.document) as PolicyDocument;
    }
    return null;
  }

  // --- delegation ---------------------------------------------------------

  async createDelegation(
    fromPrincipal: string,
    toPrincipal: string,
    constraints: DelegationConstraints,
  ): Promise<{delegationId: string}> {
    const [from, to] = await Promise.all([this.getPrincipal(fromPrincipal), this.getPrincipal(toPrincipal)]);
    if (!from || !to) throw new HttpError(404, "principal not found");
    if (to.orgId !== from.orgId) throw new HttpError(422, "cross-org delegation is not allowed");
    const id = `del_${randomUUID().slice(0, 12)}`;
    await this.db.query(
      `INSERT INTO delegations (id, from_principal, to_principal, constraints) VALUES ($1,$2,$3,$4)`,
      [id, fromPrincipal, toPrincipal, JSON.stringify(constraints)],
    );
    return {delegationId: id};
  }

  async revokeDelegation(id: string): Promise<void> {
    await this.db.query(`UPDATE delegations SET revoked = TRUE WHERE id = $1`, [id]);
  }

  /**
   * Intersect every active delegation constraint targeting any principal in the agent's
   * chain. Narrowing rules: maxAmount = min; rails/categories/allowedVendors = intersection;
   * deniedVendors = union; expired if any contributing delegation has lapsed.
   */
  async effectiveConstraints(agentId: string, now = new Date()): Promise<EffectiveConstraints> {
    const chain = await this.chain(agentId);
    const ids = chain.map((p) => p.id);
    if (ids.length === 0) {
      return {maxAmountMicros: null, rails: null, categories: null, deniedVendors: new Set(), allowedVendors: null, sources: [], expired: false};
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const res = await this.db.query<{id: string; constraints: unknown}>(
      `SELECT id, constraints FROM delegations
       WHERE revoked = FALSE AND to_principal IN (${placeholders})`,
      ids,
    );

    let maxAmount: Micros | null = null;
    let rails: Set<Rail> | null = null;
    let categories: Set<string> | null = null;
    let allowedVendors: Set<string> | null = null;
    const deniedVendors = new Set<string>();
    const sources: string[] = [];
    let expired = false;

    for (const row of res.rows) {
      const c = (typeof row.constraints === "string" ? JSON.parse(row.constraints) : row.constraints) as DelegationConstraints;
      sources.push(row.id);
      if (c.expiresAt && new Date(c.expiresAt) <= now) expired = true;
      if (c.maxAmount !== undefined) {
        const m = parseAmount(c.maxAmount);
        maxAmount = maxAmount === null ? m : gt(maxAmount, m) ? m : maxAmount; // min
      }
      if (c.rails) rails = rails === null ? new Set(c.rails) : intersect(rails, c.rails);
      if (c.categories) categories = categories === null ? new Set(c.categories) : intersect(categories, c.categories);
      if (c.allowedVendors) {
        const lc = c.allowedVendors.map((v) => v.toLowerCase());
        allowedVendors = allowedVendors === null ? new Set(lc) : intersect(allowedVendors, lc);
      }
      for (const v of c.deniedVendors ?? []) deniedVendors.add(v.toLowerCase());
    }

    return {
      maxAmountMicros: maxAmount,
      rails: rails ? [...rails] : null,
      categories: categories ? [...categories] : null,
      allowedVendors: allowedVendors ? allowedVendors : null,
      deniedVendors,
      sources,
      expired,
    };
  }

  /** True if the whole chain is active (any suspended principal blocks the agent). */
  async chainActive(agentId: string): Promise<{active: boolean; suspended: string | null}> {
    const chain = await this.chain(agentId);
    if (chain.length === 0) return {active: false, suspended: null};
    for (const p of chain) if (p.status !== "active") return {active: false, suspended: p.id};
    return {active: true, suspended: null};
  }

  private map(r: PrincipalRow): Principal {
    return {
      id: r.id,
      kind: r.kind,
      parentId: r.parent_id,
      orgId: r.org_id,
      displayName: r.display_name,
      status: r.status,
      policyId: r.policy_id,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
}

function intersect<T>(a: Set<T>, b: T[]): Set<T> {
  const bs = new Set(b);
  return new Set([...a].filter((x) => bs.has(x)));
}

export function vendorIdStr(v: Hex | null | undefined): string | null {
  return v ? v.toLowerCase() : null;
}
