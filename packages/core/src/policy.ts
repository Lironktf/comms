import {z} from "zod";

/**
 * ACTP V6/V11 — spending policy model.
 *
 * A policy is an ordered list of statements. Each statement has an effect
 * (allow | deny | require_approval) and a set of conditions that ALL must hold (AND).
 * Cross-statement disjunction (OR) is expressed as multiple statements.
 *
 * Evaluation is deny-overrides, allow-required, deny-by-default (fail closed):
 *   any matched deny            -> deny
 *   else any matched approval   -> require_approval
 *   else any matched allow      -> allow
 *   else                        -> deny            (nothing explicitly allowed it)
 *
 * The condition language is deliberately not Turing-complete — a fixed attribute registry,
 * comparison operators, no loops or recursion — so every policy terminates and is fully
 * explainable (each decision returns the exact statements that fired). This is the "Cedar
 * property" the design doc calls for, purpose-built for money and cross-rail context.
 */

/** The typed attributes a condition may reference. This registry is the single source of
 *  truth shared by schema validation, the evaluator, and the human-readable language. */
export const POLICY_ATTRIBUTES = {
  "amount": "number", // request amount normalized to the policy's currency (e.g. USD)
  "currency": "string", // original currency/asset of the request
  "rail": "string", // x402 | acp | card | ap2 | sepa | ach | other
  "category": "string",
  "subscription": "boolean", // request flagged as a recurring charge
  "vendor.known": "boolean", // resolved to a registry vendor?
  "vendor.status": "string", // active | suspended | revoked | unknown
  "vendor.verificationLevel": "number", // 0–5
  "vendor.registryAgeDays": "number",
  "vendor.domainAgeDays": "number",
  "risk.level": "string", // low | medium | high | critical | unknown
  "risk.score": "number", // 0–100
  "contract.subscription": "boolean",
  "contract.autoRenews": "boolean",
  "contract.arbitration": "boolean",
  "contract.earlyTerminationFee": "boolean",
  "time.hourUtc": "number", // 0–23
} as const;

export type PolicyAttribute = keyof typeof POLICY_ATTRIBUTES;
export type PolicyAttributeType = (typeof POLICY_ATTRIBUTES)[PolicyAttribute];

export const POLICY_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "exists"] as const;
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

export const conditionSchema = z
  .object({
    attr: z.enum(Object.keys(POLICY_ATTRIBUTES) as [PolicyAttribute, ...PolicyAttribute[]]),
    op: z.enum(POLICY_OPERATORS),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const type = POLICY_ATTRIBUTES[c.attr];
    if (c.op === "in" || c.op === "nin") {
      if (!Array.isArray(c.value)) ctx.addIssue({code: "custom", message: `${c.op} requires an array value`});
      return;
    }
    if (c.op === "exists") {
      if (typeof c.value !== "boolean") {
        ctx.addIssue({code: "custom", message: "exists requires a boolean value"});
      }
      return;
    }
    if ((c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte") && type !== "number") {
      ctx.addIssue({code: "custom", message: `${c.op} only applies to numeric attributes (${c.attr})`});
    }
    if (Array.isArray(c.value)) {
      ctx.addIssue({code: "custom", message: `${c.op} requires a scalar value`});
      return;
    }
    if (typeof c.value !== type && !(type === "number" && typeof c.value === "number")) {
      // allow string attrs compared to string, boolean to boolean, number to number
      if (type !== typeof c.value) {
        ctx.addIssue({code: "custom", message: `attribute ${c.attr} is ${type}, got ${typeof c.value}`});
      }
    }
  });

export type Condition = z.infer<typeof conditionSchema>;

export const statementSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/),
    effect: z.enum(["allow", "deny", "require_approval"]),
    description: z.string().max(280).optional(),
    /** All conditions must hold for the statement to fire (AND). Empty = always fires. */
    when: z.array(conditionSchema).max(32).default([]),
  })
  .strict();

export type Statement = z.infer<typeof statementSchema>;

export const policyDocumentSchema = z
  .object({
    schema: z.literal("actp.policy.v1"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Currency that `amount` conditions and budgets are normalized to (e.g. "USD"). */
    normalizedCurrency: z.string().default("USD"),
    statements: z.array(statementSchema).min(1).max(256),
  })
  .strict();

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

export function validatePolicy(doc: unknown): PolicyDocument {
  return policyDocumentSchema.parse(doc);
}

/** The typed context a policy is evaluated against. Built by the decision service from the
 *  normalized request + resolved vendor/risk/contract state. */
export interface PolicyContext {
  amount: number;
  currency: string;
  rail: string;
  category: string | null;
  subscription: boolean;
  vendor: {
    known: boolean;
    status: string;
    verificationLevel: number;
    registryAgeDays: number | null;
    domainAgeDays: number | null;
  };
  risk: {level: string; score: number | null};
  contract: {
    subscription: boolean;
    autoRenews: boolean;
    arbitration: boolean;
    earlyTerminationFee: boolean;
  };
  time: {hourUtc: number};
}
