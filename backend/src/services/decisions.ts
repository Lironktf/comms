import {randomUUID} from "node:crypto";
import {
  canonicalize,
  formatAmount,
  type Decision,
  type DecisionOutcome,
  type DecisionReason,
  type DecisionTokenPayload,
  type PolicyContext,
  type PurchaseRequest,
} from "@actp/core";
import {keccak256, toBytes, type Hex} from "viem";
import type {Db} from "../db/client.js";
import type {AppConfig} from "../config.js";
import {evaluatePolicy} from "../policy/engine.js";
import {TokenSigner, newNonce} from "../crypto/tokens.js";
import {verifyAgentAuth, verifyMandate} from "../crypto/agentAuth.js";
import {HttpError} from "./metadata.js";
import {PrincipalService} from "./principals.js";
import {BudgetService, FxUnavailableError} from "./budgets.js";
import {RiskEngine} from "./risk/engine.js";
import {VendorService} from "./vendors.js";
import {ContractIntelService} from "./contractIntel/service.js";
import {ApprovalService} from "./approvals.js";
import {ReceiptService} from "./receipts.js";

/**
 * ACTP V12 — the decision service. The single, rail-agnostic entry point: a normalized
 * PurchaseRequest goes in; an ALLOW/DENY/REQUIRE_APPROVAL decision (with a signed enforcement
 * token on allow) comes out. It assembles context (principal chain + delegation + vendor +
 * verification + risk + contract terms + cross-rail budgets), runs ONE policy evaluation,
 * enforces budgets with a hold, and writes a receipt. Every rail flows through here.
 */
export class DecisionService {
  constructor(
    private readonly db: Db,
    private readonly principals: PrincipalService,
    private readonly budgets: BudgetService,
    private readonly risk: RiskEngine,
    private readonly vendors: VendorService,
    private readonly contractIntel: ContractIntelService,
    private readonly approvals: ApprovalService,
    private readonly receipts: ReceiptService,
    private readonly signer: TokenSigner,
    private readonly config: AppConfig,
  ) {}

  async decide(req: PurchaseRequest, now = new Date()): Promise<Decision> {
    const agentId = req.principal.agentId;

    // idempotency: same (agent, requestId) returns the same decision
    const existing = await this.findByRequest(agentId, req.requestId);
    if (existing) return existing;

    const decisionId = `dec_${randomUUID().slice(0, 16)}`;
    const reasons: DecisionReason[] = [];

    const chain = await this.principals.chain(agentId);
    if (chain.length === 0) {
      return this.finalize(decisionId, req, null, "deny", "none", zeroHash(), [
        {source: "principal", rule: "principal.unknown", effect: "deny", evidence: {agentId}},
      ], now, [], null, {level: null, score: null});
    }
    const org = chain[chain.length - 1]!;

    // --- resolve counterparty --------------------------------------------
    let vendorId: string | null = req.payee.vendorId?.toLowerCase() ?? null;
    if (!vendorId && req.payee.wallet) vendorId = await this.vendors.resolveByWallet(req.payee.wallet);
    if (!vendorId && req.payee.domain) vendorId = await this.vendors.resolveByDomain(req.payee.domain);
    const vendor = vendorId ? await this.vendors.getVendor(vendorId) : null;

    // --- risk + contract terms -------------------------------------------
    let riskLevel = "unknown";
    let riskScore: number | null = null;
    let domainAgeDays: number | null = null;
    if (vendor) {
      const signals = await this.risk.assembleSignals(vendor.vendorId, now);
      domainAgeDays = signals.domainAgeDays ?? null;
      const scored = this.risk.score(vendor.vendorId, signals, now);
      riskLevel = scored.riskLevel;
      riskScore = scored.score;
    }

    const st = vendor ? await this.contractIntel.getLatestTerms(vendor.vendorId) : null;
    const terms = st?.terms;
    const contract = {
      subscription:
        Boolean(terms?.autoRenews?.value) ||
        (terms?.renewalCadence?.value !== undefined && terms.renewalCadence.value !== "none"),
      autoRenews: Boolean(terms?.autoRenews?.value),
      arbitration: Boolean(terms?.arbitrationClause?.value?.present),
      earlyTerminationFee: Boolean(terms?.earlyTerminationFee?.value?.present),
    };

    // --- normalize amount for policy `amount` attribute ------------------
    const policy = await this.principals.effectivePolicy(agentId);
    const normalizedCurrency = policy?.normalizedCurrency ?? this.config.NORMALIZED_CURRENCY;
    let normalizedAmount: number;
    try {
      normalizedAmount = Number(formatAmount(this.budgets.normalize(req.amount, normalizedCurrency).micros));
    } catch (e) {
      if (e instanceof FxUnavailableError) {
        return this.finalize(decisionId, req, vendor?.vendorId ?? null, "deny", policy?.version ?? "none", zeroHash(), [
          {source: "budget", rule: "budget.fx_unavailable", effect: "deny", evidence: {currency: e.currency}},
        ], now, [], vendor, {level: riskLevel, score: riskScore});
      }
      throw e;
    }

    const registryAgeDays = vendor
      ? Math.floor((now.getTime() - new Date(vendor.registeredAt).getTime()) / 86_400_000)
      : null;

    // agent identity (Web-Bot-Auth-style) + user mandate (AP2-style) — verified server-side
    const agentVerified = req.agentAuth
      ? verifyAgentAuth(req.agentAuth) && req.agentAuth.agentId === agentId
      : false;
    const mandateCheck = req.mandate ? verifyMandate(req.mandate) : null;
    const mandatePresent = mandateCheck?.valid ?? false;

    const ctx: PolicyContext = {
      amount: normalizedAmount,
      currency: req.amount.currency.toUpperCase(),
      rail: req.rail,
      category: req.category ?? null,
      subscription: req.subscription ?? false,
      vendor: {
        known: !!vendor,
        status: vendor?.status ?? "unknown",
        verificationLevel: vendor?.verificationLevel ?? 0,
        registryAgeDays,
        domainAgeDays,
      },
      risk: {level: riskLevel, score: riskScore},
      contract,
      agent: {verified: agentVerified},
      mandate: {present: mandatePresent},
      time: {hourUtc: now.getUTCHours()},
    };
    const contextHash = keccak256(toBytes(canonicalize({ctx, vendorId, rail: req.rail, amount: req.amount})));

    // --- delegation constraint gates (hard, pre-policy) ------------------
    const chainStatus = await this.principals.chainActive(agentId);
    if (!chainStatus.active) {
      reasons.push({source: "principal", rule: "principal.suspended", effect: "deny", evidence: {suspended: chainStatus.suspended}});
    }
    const eff = await this.principals.effectiveConstraints(agentId, now);
    if (eff.expired) reasons.push({source: "principal", rule: "delegation.expired", effect: "deny", evidence: {sources: eff.sources}});
    if (eff.maxAmountMicros !== null && this.budgets.normalize(req.amount, normalizedCurrency).micros > eff.maxAmountMicros) {
      reasons.push({source: "principal", rule: "delegation.max_amount", effect: "deny", evidence: {max: formatAmount(eff.maxAmountMicros), amount: normalizedAmount}});
    }
    if (eff.rails && !eff.rails.includes(req.rail)) {
      reasons.push({source: "principal", rule: "delegation.rail", effect: "deny", evidence: {allowed: eff.rails, rail: req.rail}});
    }
    if (eff.categories && req.category && !eff.categories.includes(req.category)) {
      reasons.push({source: "principal", rule: "delegation.category", effect: "deny", evidence: {allowed: eff.categories, category: req.category}});
    }
    if (vendorId && eff.deniedVendors.has(vendorId)) {
      reasons.push({source: "principal", rule: "delegation.vendor_denied", effect: "deny", evidence: {vendorId}});
    }
    if (eff.allowedVendors && (!vendorId || !eff.allowedVendors.has(vendorId))) {
      reasons.push({source: "principal", rule: "delegation.vendor_not_allowed", effect: "deny", evidence: {vendorId}});
    }
    const gateDenied = reasons.some((r) => r.effect === "deny");

    // --- policy evaluation ------------------------------------------------
    let outcome: DecisionOutcome;
    let policyVersion: string;
    if (!policy) {
      outcome = "deny";
      policyVersion = "none";
      reasons.push({source: "policy", rule: "policy.none", effect: "deny", evidence: {note: "no policy configured for principal chain"}});
    } else {
      const evaln = evaluatePolicy(policy, ctx);
      policyVersion = evaln.policyVersion;
      outcome = evaln.outcome;
      for (const f of evaln.fired) {
        reasons.push({
          source: "policy",
          rule: f.id,
          effect: f.effect,
          evidence: {conditions: f.conditions.map((c) => ({attr: c.condition.attr, op: c.condition.op, value: c.condition.value, actual: c.actual}))},
        });
      }
    }
    if (gateDenied) outcome = "deny";

    // --- agent-auth / mandate signals ------------------------------------
    if (req.agentAuth) {
      reasons.push({source: "principal", rule: agentVerified ? "agent.verified" : "agent.auth_invalid", effect: "signal", evidence: {agentId: req.agentAuth.agentId}});
    }
    if (req.mandate) {
      reasons.push({source: "principal", rule: mandatePresent ? "mandate.verified" : "mandate.invalid", effect: "signal", evidence: mandateCheck?.constraints ?? {}});
    }

    // --- risk/verification signals (informational, always recorded) ------
    if (vendor) {
      reasons.push({source: "risk", rule: `risk.${riskLevel}`, effect: "signal", evidence: {score: riskScore, verificationLevel: vendor.verificationLevel}});
    } else {
      reasons.push({source: "vendor", rule: "vendor.unknown", effect: "signal", evidence: {payee: req.payee}});
    }

    // --- budget enforcement + token minting ------------------------------
    let holdIds: string[] = [];
    let token: string | null = null;
    let approvalId: string | null = null;

    if (outcome === "allow") {
      const hold = await this.budgets.checkAndHold(chain.map((p) => p.id), agentId, decisionId, req.amount, now);
      for (const u of hold.usage) {
        reasons.push({source: "budget", rule: "budget.usage", effect: "signal", evidence: u});
      }
      if (!hold.ok) {
        outcome = "deny";
        reasons.push({source: "budget", rule: "budget.exceeded", effect: "deny", evidence: hold.violation ?? {}});
      } else {
        holdIds = hold.holdIds;
        token = this.mintToken(decisionId, req, vendorId, now);
      }
    }

    if (outcome === "require_approval") {
      const approval = await this.approvals.create({
        decisionId,
        principalId: agentId,
        orgId: org.id,
        amount: req.amount,
        context: {vendorId, riskLevel, riskScore, verificationLevel: vendor?.verificationLevel ?? 0, reasons},
        tokenPayload: {
          decisionId,
          principal: agentId,
          rail: req.rail,
          payee: req.payee as Record<string, unknown>,
          maxAmount: req.amount.value,
          currency: req.amount.currency.toUpperCase(),
          vendorId,
        },
        ttlSeconds: this.config.APPROVAL_TTL_SECONDS,
        now,
      });
      approvalId = approval.id;
    }

    return this.finalize(decisionId, req, vendorId, outcome, policyVersion, contextHash, reasons, now, holdIds, vendor, {level: riskLevel, score: riskScore}, approvalId, token);
  }

  /** Grant a pending approval: place the budget hold now, mint the token, flip the decision. */
  async approve(approvalId: string, resolver: string, now = new Date()): Promise<Decision> {
    const approval = await this.approvals.getActionable(approvalId, now);
    const chain = await this.principals.chain(approval.principalId);
    const hold = await this.budgets.checkAndHold(chain.map((p) => p.id), approval.principalId, approval.decisionId, approval.amount, now);
    if (!hold.ok) throw new HttpError(409, `budget would be exceeded at approval time: ${JSON.stringify(hold.violation)}`);

    const payload: DecisionTokenPayload = {
      decisionId: approval.tokenPayload.decisionId,
      principal: approval.tokenPayload.principal,
      rail: approval.tokenPayload.rail as DecisionTokenPayload["rail"],
      payee: approval.tokenPayload.payee as DecisionTokenPayload["payee"],
      maxAmount: approval.tokenPayload.maxAmount,
      currency: approval.tokenPayload.currency,
      vendorId: (approval.tokenPayload.vendorId as Hex | null) ?? null,
      issuedAt: Math.floor(now.getTime() / 1000),
      expiresAt: Math.floor(now.getTime() / 1000) + this.config.DECISION_TOKEN_TTL_SECONDS,
      nonce: newNonce(),
    };
    const token = this.signer.mint(payload);

    await this.approvals.markResolved(approvalId, "approved", resolver, null, now);
    await this.db.query(`UPDATE decisions SET outcome = 'allow' WHERE id = $1`, [approval.decisionId]);
    await this.receipts.append(approval.orgId, "approval", {
      approvalId,
      decisionId: approval.decisionId,
      resolver,
      outcome: "approved",
      holdIds: hold.holdIds,
    });

    const decision = await this.getDecision(approval.decisionId);
    if (!decision) throw new HttpError(500, "decision vanished");
    return {...decision, outcome: "allow", token, holdIds: hold.holdIds, approvalId};
  }

  async deny(approvalId: string, resolver: string, reason: string, now = new Date()): Promise<void> {
    const approval = await this.approvals.getActionable(approvalId, now);
    await this.approvals.markResolved(approvalId, "denied", resolver, reason, now);
    await this.receipts.append(approval.orgId, "approval", {approvalId, decisionId: approval.decisionId, resolver, outcome: "denied", reason});
  }

  /** Confirm (or fail) a settlement: settle/release holds, record for reputation, append receipt. */
  async settle(
    decisionId: string,
    outcome: "fulfilled" | "disputed" | "refunded" | "failed",
    now = new Date(),
  ): Promise<void> {
    const decision = await this.getDecision(decisionId);
    if (!decision) throw new HttpError(404, "decision not found");

    if (outcome === "fulfilled") await this.budgets.settle(decisionId, now);
    else await this.budgets.release(decisionId);

    const id = `stl_${randomUUID().slice(0, 12)}`;
    await this.db.query(
      `INSERT INTO settlements (id, decision_id, vendor_id, principal_id, verification_level, outcome)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, decisionId, decision.vendorId, decision.principal.agentId, decision.verificationLevel ?? 0, outcome],
    );
    await this.receipts.append(orgIdFromDecision(decision), "settlement", {decisionId, outcome, vendorId: decision.vendorId});
  }

  async getDecision(decisionId: string): Promise<Decision | null> {
    const res = await this.db.query<DecisionRow>(`SELECT * FROM decisions WHERE id = $1`, [decisionId]);
    return res.rows[0] ? mapDecision(res.rows[0]) : null;
  }

  async listDecisions(orgId: string, limit = 50): Promise<Decision[]> {
    const res = await this.db.query<DecisionRow>(
      `SELECT * FROM decisions WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [orgId, Math.min(limit, 200)],
    );
    return res.rows.map(mapDecision);
  }

  /** Verify a decision token — for enforcement points (facilitators, issuers, A2A endpoints). */
  verifyToken(token: string, now = new Date()): DecisionTokenPayload {
    return this.signer.verify(token, now);
  }

  // --- internals ----------------------------------------------------------

  private mintToken(decisionId: string, req: PurchaseRequest, vendorId: string | null, now: Date): string {
    const payload: DecisionTokenPayload = {
      decisionId,
      principal: req.principal.agentId,
      rail: req.rail,
      payee: req.payee,
      maxAmount: req.amount.value,
      currency: req.amount.currency.toUpperCase(),
      vendorId: (vendorId as Hex | null) ?? null,
      issuedAt: Math.floor(now.getTime() / 1000),
      expiresAt: Math.floor(now.getTime() / 1000) + this.config.DECISION_TOKEN_TTL_SECONDS,
      nonce: newNonce(),
    };
    return this.signer.mint(payload);
  }

  private async findByRequest(agentId: string, requestId: string): Promise<Decision | null> {
    const res = await this.db.query<DecisionRow>(
      `SELECT * FROM decisions WHERE principal_id = $1 AND request_id = $2`,
      [agentId, requestId],
    );
    return res.rows[0] ? mapDecision(res.rows[0]) : null;
  }

  private async finalize(
    decisionId: string,
    req: PurchaseRequest,
    vendorId: string | null,
    outcome: DecisionOutcome,
    policyVersion: string,
    contextHash: Hex,
    reasons: DecisionReason[],
    now: Date,
    holdIds: string[],
    vendor: Awaited<ReturnType<VendorService["getVendor"]>>,
    risk: {level: string | null; score: number | null},
    approvalId: string | null = null,
    token: string | null = null,
  ): Promise<Decision> {
    const chain = await this.principals.chain(req.principal.agentId);
    const orgId = chain.length ? chain[chain.length - 1]!.id : req.principal.agentId;

    const decision: Decision = {
      decisionId,
      requestId: req.requestId,
      principal: req.principal,
      rail: req.rail,
      amount: req.amount,
      outcome,
      reasons,
      vendorId: (vendorId as Hex | null) ?? null,
      verificationLevel: vendor?.verificationLevel ?? null,
      riskLevel: risk.level,
      riskScore: risk.score,
      policyVersion,
      contextHash,
      holdIds,
      approvalId,
      token,
      evaluatedAt: now.toISOString(),
    };

    await this.db.query(
      `INSERT INTO decisions
         (id, request_id, principal_id, org_id, rail, amount, outcome, vendor_id, verification_level, risk_level, risk_score, policy_version, context_hash, reasons, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (principal_id, request_id) DO NOTHING`,
      [
        decisionId,
        req.requestId,
        req.principal.agentId,
        orgId,
        req.rail,
        JSON.stringify(req.amount),
        outcome,
        decision.vendorId,
        decision.verificationLevel,
        decision.riskLevel,
        decision.riskScore,
        policyVersion,
        contextHash,
        JSON.stringify(reasons),
        now,
      ],
    );
    // metadata for downstream org lookup on settlement
    (decision as Decision & {_orgId?: string})._orgId = orgId;
    await this.receipts.append(orgId, "decision", {
      decisionId,
      requestId: req.requestId,
      principal: req.principal.agentId,
      rail: req.rail,
      amount: req.amount,
      outcome,
      vendorId: decision.vendorId,
    });
    return decision;
  }
}

interface DecisionRow {
  id: string;
  request_id: string;
  principal_id: string;
  org_id: string;
  rail: string;
  amount: unknown;
  outcome: DecisionOutcome;
  vendor_id: string | null;
  verification_level: number | null;
  risk_level: string | null;
  risk_score: number | null;
  policy_version: string;
  context_hash: string;
  reasons: unknown;
  created_at: string | Date;
}

const decisionOrg = new WeakMap<Decision, string>();

function mapDecision(r: DecisionRow): Decision {
  const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
  const d: Decision = {
    decisionId: r.id,
    requestId: r.request_id,
    principal: {agentId: r.principal_id},
    rail: r.rail as Decision["rail"],
    amount: parse(r.amount),
    outcome: r.outcome,
    reasons: parse<DecisionReason[]>(r.reasons),
    vendorId: (r.vendor_id as Hex | null) ?? null,
    verificationLevel: r.verification_level,
    riskLevel: r.risk_level,
    riskScore: r.risk_score,
    policyVersion: r.policy_version,
    contextHash: r.context_hash as Hex,
    holdIds: [],
    approvalId: null,
    token: null,
    evaluatedAt: new Date(r.created_at).toISOString(),
  };
  decisionOrg.set(d, r.org_id);
  return d;
}

function orgIdFromDecision(d: Decision): string {
  return decisionOrg.get(d) ?? (d as Decision & {_orgId?: string})._orgId ?? d.principal.agentId;
}

function zeroHash(): Hex {
  return `0x${"00".repeat(32)}`;
}
