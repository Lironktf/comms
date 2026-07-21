import {z} from "zod";
import type {ActpClient} from "@actp/sdk";
import type {Hex} from "viem";

/**
 * ACTP as agent tools. Any MCP-speaking agent (Claude, etc.) gets, with zero custom
 * integration, the ability to ask "who is this merchant, how risky, and am I allowed to pay
 * them?" — and to receive an allow/deny/approval decision (with a signed enforcement token)
 * before it spends. This is ACTP's distribution surface: the agent-facing side of the layer.
 */

export interface ActpTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (client: ActpClient, args: Record<string, unknown>) => Promise<{summary: string; data: unknown}>;
}

const resolveMerchant: ActpTool = {
  name: "actp_resolve_merchant",
  description:
    "Resolve a merchant in the ACTP registry by domain or payout wallet. Returns its canonical " +
    "identity, verification level (0-5), and status. Use this before paying an unknown counterparty.",
  schema: z.object({
    domain: z.string().optional().describe("merchant domain, e.g. api.acme.dev"),
    wallet: z.string().optional().describe("payout wallet address"),
  }),
  async handler(client, args) {
    const domain = args.domain as string | undefined;
    const wallet = args.wallet as string | undefined;
    const vendor = domain
      ? await client.resolveDomain(domain)
      : wallet
        ? await client.resolveWallet(wallet as Hex)
        : null;
    if (!vendor) {
      return {summary: "No registered merchant matches that identifier — treat as UNKNOWN and fail closed.", data: null};
    }
    return {
      summary: `${vendor.primaryDomain} — status ${vendor.status}, verification level ${vendor.verificationLevel}/5.`,
      data: vendor,
    };
  },
};

const getRisk: ActpTool = {
  name: "actp_get_risk",
  description: "Get the explainable risk score for a merchant (low/medium/high/critical) with the reasons behind it.",
  schema: z.object({vendorId: z.string().describe("0x-prefixed 32-byte ACTP vendor id")}),
  async handler(client, args) {
    const risk = await client.getRisk(args.vendorId as Hex);
    return {
      summary: `Risk: ${risk.riskLevel} (score ${risk.score}). Top reason: ${risk.reasons[0]?.rule ?? "none"}.`,
      data: risk,
    };
  },
};

const verifiedMetadata: ActpTool = {
  name: "actp_verified_metadata",
  description:
    "Fetch a merchant's metadata and whether it is cryptographically verified against the onchain anchor. " +
    "`trusted: false` means the document is unanchored or tampered — do not rely on it.",
  schema: z.object({vendorId: z.string()}),
  async handler(client, args) {
    const meta = await client.getVerifiedMetadata(args.vendorId as Hex);
    return {
      summary: `Metadata ${meta.trusted ? "VERIFIED against the onchain anchor" : "NOT trusted (unanchored/mismatch)"}.`,
      data: meta,
    };
  },
};

const decide: ActpTool = {
  name: "actp_decide",
  description:
    "The core call: submit a purchase and get ALLOW / DENY / REQUIRE_APPROVAL under the org's policy, " +
    "across any rail. On ALLOW you receive a signed decision token the payment rail verifies before settling. " +
    "Call this before every autonomous purchase.",
  schema: z.object({
    requestId: z.string().describe("idempotency key for this purchase attempt"),
    agentId: z.string().describe("the ACTP principal (agent) making the purchase"),
    rail: z.enum(["x402", "acp", "card", "ap2", "sepa", "ach", "other"]),
    amountValue: z.string().describe("decimal amount, e.g. '29.99'"),
    amountCurrency: z.string().describe("currency/asset, e.g. USD or USDC"),
    payeeWallet: z.string().optional(),
    payeeDomain: z.string().optional(),
    payeeVendorId: z.string().optional(),
    category: z.string().optional(),
    subscription: z.boolean().optional(),
  }),
  async handler(client, args) {
    const decision = await client.decide({
      requestId: args.requestId as string,
      principal: {agentId: args.agentId as string},
      rail: args.rail as "x402",
      amount: {value: args.amountValue as string, currency: args.amountCurrency as string},
      payee: {
        ...(args.payeeWallet ? {wallet: args.payeeWallet as Hex} : {}),
        ...(args.payeeDomain ? {domain: args.payeeDomain as string} : {}),
        ...(args.payeeVendorId ? {vendorId: args.payeeVendorId as Hex} : {}),
      },
      ...(args.category ? {category: args.category as string} : {}),
      ...(args.subscription !== undefined ? {subscription: args.subscription as boolean} : {}),
    });
    const denyOrApprove = decision.reasons.find((r) => r.effect === "deny" || r.effect === "require_approval");
    const why = denyOrApprove ? ` (${denyOrApprove.rule})` : "";
    return {
      summary: `Decision: ${decision.outcome.toUpperCase()}${why}.${decision.token ? " Enforcement token issued." : ""}`,
      data: decision,
    };
  },
};

const discover: ActpTool = {
  name: "actp_discover",
  description:
    "Find trusted merchants in a category instead of searching the open web. Returns verified, low-risk " +
    "vendors ranked on merit (verification, risk, reputation) — no pay-for-placement.",
  schema: z.object({
    category: z.string().optional(),
    minVerificationLevel: z.number().optional(),
    maxRiskScore: z.number().optional(),
  }),
  async handler(client, args) {
    const results = await client.discover({
      ...(args.category ? {category: args.category as string} : {}),
      ...(args.minVerificationLevel !== undefined ? {minLevel: args.minVerificationLevel as number} : {}),
      ...(args.maxRiskScore !== undefined ? {maxRisk: args.maxRiskScore as number} : {}),
    });
    return {summary: `${results.length} trusted merchant(s) found.`, data: results};
  },
};

export const ACTP_TOOLS: ActpTool[] = [resolveMerchant, getRisk, verifiedMetadata, decide, discover];
