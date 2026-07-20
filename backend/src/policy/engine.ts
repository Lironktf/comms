import {
  type Condition,
  type DecisionOutcome,
  type PolicyContext,
  type PolicyDocument,
} from "@actp/core";

/**
 * ACTP V6 — policy evaluator.
 *
 * Pure and total: (policy, context) -> outcome + the exact statements that fired. No I/O, no
 * clock, no loops beyond a finite pass over statements/conditions. Deterministic and fully
 * explainable, which is the whole point — an agent that is denied (or a human asked to
 * approve) can be told precisely which rule and which evidence caused it.
 *
 * Combining algorithm (fail closed): deny-overrides > require_approval > allow > default deny.
 */

export interface StatementMatch {
  id: string;
  effect: DecisionOutcome;
  description?: string;
  matched: boolean;
  /** the conditions and whether each held, for explainability */
  conditions: {condition: Condition; held: boolean; actual: unknown}[];
}

export interface PolicyEvaluation {
  outcome: DecisionOutcome;
  policyVersion: string;
  /** statements that fired, most-restrictive first */
  fired: StatementMatch[];
  /** the winning statement, or null when the default-deny applied */
  determiningStatement: string | null;
}

const PRECEDENCE: Record<DecisionOutcome, number> = {deny: 3, require_approval: 2, allow: 1};

export function evaluatePolicy(policy: PolicyDocument, ctx: PolicyContext): PolicyEvaluation {
  const fired: StatementMatch[] = [];

  for (const stmt of policy.statements) {
    const conditions = stmt.when.map((c) => {
      const actual = readAttr(ctx, c.attr);
      return {condition: c, held: evalCondition(c, actual), actual};
    });
    const matched = conditions.every((c) => c.held);
    if (matched) {
      fired.push({
        id: stmt.id,
        effect: stmt.effect,
        ...(stmt.description ? {description: stmt.description} : {}),
        matched: true,
        conditions,
      });
    }
  }

  // deny-overrides > require_approval > allow ; nothing fired -> deny (fail closed)
  let outcome: DecisionOutcome = "deny";
  let determining: string | null = null;
  for (const f of fired) {
    if (determining === null || PRECEDENCE[f.effect] > PRECEDENCE[outcome]) {
      outcome = f.effect;
      determining = f.id;
    }
  }

  fired.sort((a, b) => PRECEDENCE[b.effect] - PRECEDENCE[a.effect] || a.id.localeCompare(b.id));

  return {outcome, policyVersion: policy.version, fired, determiningStatement: determining};
}

function readAttr(ctx: PolicyContext, attr: string): unknown {
  switch (attr) {
    case "amount":
      return ctx.amount;
    case "currency":
      return ctx.currency;
    case "rail":
      return ctx.rail;
    case "category":
      return ctx.category;
    case "subscription":
      return ctx.subscription;
    case "vendor.known":
      return ctx.vendor.known;
    case "vendor.status":
      return ctx.vendor.status;
    case "vendor.verificationLevel":
      return ctx.vendor.verificationLevel;
    case "vendor.registryAgeDays":
      return ctx.vendor.registryAgeDays;
    case "vendor.domainAgeDays":
      return ctx.vendor.domainAgeDays;
    case "risk.level":
      return ctx.risk.level;
    case "risk.score":
      return ctx.risk.score;
    case "contract.subscription":
      return ctx.contract.subscription;
    case "contract.autoRenews":
      return ctx.contract.autoRenews;
    case "contract.arbitration":
      return ctx.contract.arbitration;
    case "contract.earlyTerminationFee":
      return ctx.contract.earlyTerminationFee;
    case "time.hourUtc":
      return ctx.time.hourUtc;
    default:
      return undefined;
  }
}

function evalCondition(c: Condition, actual: unknown): boolean {
  switch (c.op) {
    case "exists":
      return (actual !== null && actual !== undefined) === (c.value as boolean);
    case "eq":
      return actual === c.value;
    case "ne":
      return actual !== c.value;
    case "in":
      return Array.isArray(c.value) && (c.value as unknown[]).includes(actual as never);
    case "nin":
      return Array.isArray(c.value) && !(c.value as unknown[]).includes(actual as never);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // Numeric comparisons: a null/absent attribute never satisfies an ordering — fail
      // closed (an unknown domain age must not slip under a "domainAgeDays < 90" allow).
      if (typeof actual !== "number" || typeof c.value !== "number") return false;
      if (c.op === "gt") return actual > c.value;
      if (c.op === "gte") return actual >= c.value;
      if (c.op === "lt") return actual < c.value;
      return actual <= c.value;
    }
    default:
      return false;
  }
}
