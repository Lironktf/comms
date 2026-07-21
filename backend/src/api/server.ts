import Fastify, {type FastifyInstance} from "fastify";
import {ZodError} from "zod";
import type {AppConfig} from "../config.js";
import type {Db} from "../db/client.js";
import {computeCid, formatAmount, isValidCid, parsePolicyText, renderPolicyText, validatePolicy, type PurchaseRequest} from "@actp/core";
import {HttpError, MetadataService} from "../services/metadata.js";
import {VendorService} from "../services/vendors.js";
import {ContractIntelService} from "../services/contractIntel/service.js";
import {RiskEngine} from "../services/risk/engine.js";
import type {IpfsStore} from "../storage/ipfs.js";
import type {PrincipalService} from "../services/principals.js";
import type {BudgetService, BudgetPeriod} from "../services/budgets.js";
import type {ApprovalService} from "../services/approvals.js";
import type {ReceiptService} from "../services/receipts.js";
import type {ReputationService} from "../services/reputation.js";
import type {DiscoveryService} from "../services/discovery.js";
import type {BazaarService, BazaarListingInput} from "../services/bazaar.js";
import type {KybService} from "../services/kyb/service.js";
import type {DecisionService} from "../services/decisions.js";
import {verifyAgentAuth, verifyMandate} from "../crypto/agentAuth.js";
import type {AgentAuth, SignedMandate} from "@actp/core";
import type {TokenSigner} from "../crypto/tokens.js";
import {normalizeX402, normalizeAcp, normalizeCard, normalizeAp2} from "../rails/adapters.js";
import {authorizeX402Settlement, buildX402Extension, type X402Payment} from "../rails/x402.js";

export interface AppServices {
  db: Db;
  vendors: VendorService;
  metadata: MetadataService;
  contractIntel: ContractIntelService;
  risk: RiskEngine;
  ipfs: IpfsStore;
  principals: PrincipalService;
  budgets: BudgetService;
  approvals: ApprovalService;
  receipts: ReceiptService;
  reputation: ReputationService;
  discovery: DiscoveryService;
  bazaar: BazaarService;
  kyb: KybService;
  decisions: DecisionService;
  signer: TokenSigner;
}

/**
 * ACTP REST API.
 *
 * Reads are public (the registry is public data). Mutating endpoints (metadata publish,
 * document ingestion, risk signals) require the admin API key when one is configured —
 * ACTP's onchain state needs no API auth at all, since authorization lives in the contracts.
 */
export function buildServer(services: AppServices, config: AppConfig): FastifyInstance {
  const app = Fastify({logger: {level: config.LOG_LEVEL}, bodyLimit: 4 * 1024 * 1024});
  const {vendors, metadata, contractIntel, risk, ipfs, principals, budgets, approvals, receipts, reputation, discovery, bazaar, kyb, decisions, signer} =
    services;

  const requireAdmin = (req: {headers: Record<string, unknown>}) => {
    if (!config.ADMIN_API_KEY) return; // dev mode: open
    if (req.headers["x-api-key"] !== config.ADMIN_API_KEY) {
      throw new HttpError(401, "invalid or missing x-api-key");
    }
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({error: err.message});
    }
    if (err instanceof ZodError) {
      return reply.status(422).send({error: "validation failed", issues: err.issues});
    }
    const e = err as Error & {statusCode?: number};
    if (typeof e.statusCode === "number") {
      return reply.status(e.statusCode).send({error: e.message});
    }
    app.log.error(err);
    return reply.status(500).send({error: "internal error"});
  });

  app.get("/health", async () => ({status: "ok"}));

  // Content-addressed gateway: serve a stored document by CID, verifying the bytes hash to
  // the requested CID before returning them. Clients still re-verify (that's the point of a
  // content address), so this is a convenience cache, not a trusted source.
  app.get("/ipfs/:cid", async (req, reply) => {
    const {cid} = req.params as {cid: string};
    if (!isValidCid(cid)) throw new HttpError(422, "invalid CID");
    const bytes = await ipfs.get(cid);
    if (!bytes) throw new HttpError(404, "not found in content-addressed store");
    if ((await computeCid(bytes)) !== cid) throw new HttpError(500, "stored bytes do not match CID");
    return reply.header("content-type", "application/octet-stream").send(Buffer.from(bytes));
  });

  // ------------------------------------------------------------------ vendors
  app.get("/v1/vendors", async (req) => {
    const q = req.query as {domain?: string; wallet?: string; limit?: string; offset?: string};
    if (q.domain) {
      const vendorId = await vendors.resolveByDomain(q.domain);
      if (!vendorId) throw new HttpError(404, "no vendor claims this domain");
      return {vendor: await vendors.getVendor(vendorId)};
    }
    if (q.wallet) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(q.wallet)) throw new HttpError(422, "invalid wallet address");
      const vendorId = await vendors.resolveByWallet(q.wallet);
      if (!vendorId) throw new HttpError(404, "no vendor claims this wallet");
      return {vendor: await vendors.getVendor(vendorId)};
    }
    return {vendors: await vendors.listVendors(Number(q.limit ?? 50), Number(q.offset ?? 0))};
  });

  app.get("/v1/vendors/:vendorId", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    const vendor = await vendors.getVendor(assertVendorId(vendorId));
    if (!vendor) throw new HttpError(404, "vendor not found");
    return {vendor};
  });

  app.get("/v1/vendors/:vendorId/attestations", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    return {attestations: await vendors.getAttestations(assertVendorId(vendorId))};
  });

  // ------------------------------------------------------------------ V3 metadata
  app.put("/v1/vendors/:vendorId/metadata", async (req, reply) => {
    requireAdmin(req);
    const {vendorId} = req.params as {vendorId: string};
    const result = await metadata.publish(assertVendorId(vendorId), req.body);
    return reply.status(201).send({
      version: result.version,
      canonicalHash: result.canonicalHash,
      cid: result.cid,
      uri: result.uri,
      next_step:
        `anchor onchain: VendorRegistry.setMetadata(vendorId, ${result.canonicalHash}, "${result.uri}") from the vendor owner key`,
    });
  });

  app.get("/v1/vendors/:vendorId/metadata", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    const doc = await metadata.getLatest(assertVendorId(vendorId));
    if (!doc) throw new HttpError(404, "no metadata published");
    return doc;
  });

  // ------------------------------------------------------------------ V4 contract intelligence
  app.post("/v1/vendors/:vendorId/contract-documents", async (req, reply) => {
    requireAdmin(req);
    const {vendorId} = req.params as {vendorId: string};
    const body = req.body as {content?: string; docType?: string; sourceUrl?: string};
    if (typeof body?.content !== "string") throw new HttpError(422, "content (string) is required");
    const docType = (body.docType ?? "terms_of_service") as
      | "terms_of_service"
      | "pricing_page"
      | "refund_policy"
      | "other";
    if (!["terms_of_service", "pricing_page", "refund_policy", "other"].includes(docType)) {
      throw new HttpError(422, "invalid docType");
    }
    const stored = await contractIntel.ingestDocument(assertVendorId(vendorId), {
      content: body.content,
      docType,
      ...(body.sourceUrl ? {sourceUrl: body.sourceUrl} : {}),
    });
    return reply.status(201).send(stored);
  });

  app.get("/v1/vendors/:vendorId/contract-terms", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    const terms = await contractIntel.getLatestTerms(assertVendorId(vendorId));
    if (!terms) throw new HttpError(404, "no contract terms extracted");
    return terms;
  });

  // ------------------------------------------------------------------ V5 risk
  app.get("/v1/vendors/:vendorId/risk", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    return await risk.evaluateVendor(assertVendorId(vendorId));
  });

  app.get("/v1/vendors/:vendorId/risk/history", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    const q = req.query as {limit?: string};
    return {history: await risk.history(assertVendorId(vendorId), Number(q.limit ?? 20))};
  });

  app.post("/v1/vendors/:vendorId/risk-signals", async (req, reply) => {
    requireAdmin(req);
    const {vendorId} = req.params as {vendorId: string};
    const body = req.body as {signal?: string; value?: unknown; source?: string};
    if (!body?.signal || body.value === undefined) {
      throw new HttpError(422, "signal and value are required");
    }
    await risk.upsertSignal(assertVendorId(vendorId), body.signal, body.value, body.source ?? "api");
    return reply.status(204).send();
  });

  // ================================================================ V7/V9 principals
  app.post("/v1/orgs", async (req, reply) => {
    requireAdmin(req);
    const body = req.body as {displayName?: string};
    if (!body?.displayName) throw new HttpError(422, "displayName required");
    return reply.status(201).send(await principals.createOrg(body.displayName));
  });

  app.post("/v1/principals/:id/children", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {kind?: "department" | "agent"; displayName?: string};
    if (body?.kind !== "department" && body?.kind !== "agent") throw new HttpError(422, "kind must be department|agent");
    if (!body.displayName) throw new HttpError(422, "displayName required");
    return reply.status(201).send(await principals.createChild(id, body.kind, body.displayName));
  });

  app.get("/v1/principals/:id", async (req) => {
    const {id} = req.params as {id: string};
    const p = await principals.getPrincipal(id);
    if (!p) throw new HttpError(404, "principal not found");
    return {principal: p, chain: await principals.chain(id)};
  });

  app.post("/v1/principals/:id/status", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {status?: "active" | "suspended"};
    if (body?.status !== "active" && body?.status !== "suspended") throw new HttpError(422, "status must be active|suspended");
    await principals.setStatus(id, body.status);
    return reply.status(204).send();
  });

  // V11 policy — accept the readable text form or the JSON document form
  app.put("/v1/principals/:id/policy", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {text?: string; version?: string; normalizedCurrency?: string; document?: unknown};
    let doc;
    if (typeof body?.text === "string") {
      doc = parsePolicyText(body.text, {version: body.version ?? "1.0.0", normalizedCurrency: body.normalizedCurrency ?? "USD"});
    } else if (body?.document) {
      doc = validatePolicy(body.document);
    } else {
      throw new HttpError(422, "provide either `text` or `document`");
    }
    const result = await principals.setPolicy(id, doc);
    return reply.status(201).send({...result, version: doc.version, statements: doc.statements.length});
  });

  app.get("/v1/principals/:id/policy", async (req) => {
    const {id} = req.params as {id: string};
    const doc = await principals.effectivePolicy(id);
    if (!doc) throw new HttpError(404, "no policy for this principal chain");
    return {document: doc, text: renderPolicyText(doc)};
  });

  app.post("/v1/delegations", async (req, reply) => {
    requireAdmin(req);
    const body = req.body as {from?: string; to?: string; constraints?: Record<string, unknown>};
    if (!body?.from || !body?.to) throw new HttpError(422, "from and to are required");
    return reply.status(201).send(await principals.createDelegation(body.from, body.to, body.constraints ?? {}));
  });

  app.delete("/v1/delegations/:id", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    await principals.revokeDelegation(id);
    return reply.status(204).send();
  });

  // ================================================================ V6 budgets
  app.post("/v1/principals/:id/budgets", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {period?: BudgetPeriod; currency?: string; limit?: string};
    if (!["day", "month", "total"].includes(body?.period ?? "")) throw new HttpError(422, "period must be day|month|total");
    if (!body?.currency || !body?.limit) throw new HttpError(422, "currency and limit are required");
    return reply.status(201).send(
      serializeBudget(await budgets.createBudget(id, body.period!, body.currency, body.limit)),
    );
  });

  app.get("/v1/principals/:id/budgets", async (req) => {
    const {id} = req.params as {id: string};
    return {budgets: (await budgets.listBudgets(id)).map(serializeBudget)};
  });

  // ================================================================ V12 decisions
  app.post("/v1/decisions", async (req, reply) => {
    const decision = await decisions.decide(req.body as PurchaseRequest);
    return reply.status(decision.outcome === "deny" ? 200 : 201).send(decision);
  });

  // cross-rail convenience: normalize a rail-native payload, then decide
  app.post("/v1/decisions/rail/:rail", async (req, reply) => {
    const {rail} = req.params as {rail: string};
    const body = req.body as {requestId?: string; principal?: {agentId: string}; payload?: unknown};
    if (!body?.requestId || !body?.principal?.agentId) throw new HttpError(422, "requestId and principal.agentId required");
    const meta = {requestId: body.requestId, principal: body.principal};
    let normalized: PurchaseRequest;
    switch (rail) {
      case "x402": normalized = normalizeX402(body.payload as never, meta); break;
      case "acp": normalized = normalizeAcp(body.payload as never, meta); break;
      case "card": normalized = normalizeCard(body.payload as never, meta); break;
      case "ap2": normalized = normalizeAp2(body.payload as never, meta); break;
      default: throw new HttpError(422, `unsupported rail: ${rail}`);
    }
    const decision = await decisions.decide(normalized);
    return reply.status(decision.outcome === "deny" ? 200 : 201).send({normalized, decision});
  });

  app.get("/v1/decisions/:id", async (req) => {
    const {id} = req.params as {id: string};
    const d = await decisions.getDecision(id);
    if (!d) throw new HttpError(404, "decision not found");
    return d;
  });

  app.get("/v1/orgs/:orgId/decisions", async (req) => {
    const {orgId} = req.params as {orgId: string};
    const q = req.query as {limit?: string};
    return {decisions: await decisions.listDecisions(orgId, Number(q.limit ?? 50))};
  });

  app.post("/v1/decisions/:id/settle", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {outcome?: "fulfilled" | "disputed" | "refunded" | "failed"};
    if (!["fulfilled", "disputed", "refunded", "failed"].includes(body?.outcome ?? "")) {
      throw new HttpError(422, "outcome must be fulfilled|disputed|refunded|failed");
    }
    await decisions.settle(id, body.outcome!);
    return reply.status(204).send();
  });

  // enforcement-point helper: verify a decision token
  app.post("/v1/decisions/verify-token", async (req) => {
    const body = req.body as {token?: string};
    if (!body?.token) throw new HttpError(422, "token required");
    try {
      return {valid: true, payload: decisions.verifyToken(body.token)};
    } catch (e) {
      return {valid: false, error: (e as Error).message};
    }
  });

  app.get("/v1/decisions/signing-key", async () => ({publicKeyPem: signer.publicKeyPem()}));

  // ---- x402 enforcement: the settle-time guard a facilitator calls before settling ----
  app.post("/v1/x402/authorize-settlement", async (req) => {
    const body = req.body as {token?: string; payment?: X402Payment};
    if (!body?.token || !body?.payment?.payTo || !body?.payment?.asset) {
      throw new HttpError(422, "token and payment {payTo, amountAtomic, asset} are required");
    }
    return authorizeX402Settlement(body.token, body.payment, signer);
  });

  // Merchants call this to build the extensions block advertising their ACTP vendor id.
  app.get("/v1/x402/extension/:vendorId", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    return {extensions: buildX402Extension(assertVendorId(vendorId))};
  });

  // ================================================================ V8 approvals
  app.get("/v1/orgs/:orgId/approvals", async (req) => {
    const {orgId} = req.params as {orgId: string};
    return {approvals: await approvals.listPending(orgId)};
  });

  app.post("/v1/approvals/:id/approve", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {resolver?: string};
    const decision = await decisions.approve(id, body?.resolver ?? "admin");
    return reply.status(200).send(decision);
  });

  app.post("/v1/approvals/:id/deny", async (req, reply) => {
    requireAdmin(req);
    const {id} = req.params as {id: string};
    const body = req.body as {resolver?: string; reason?: string};
    await decisions.deny(id, body?.resolver ?? "admin", body?.reason ?? "denied");
    return reply.status(204).send();
  });

  // ================================================================ V13 receipts
  app.get("/v1/orgs/:orgId/receipts", async (req) => {
    const {orgId} = req.params as {orgId: string};
    const q = req.query as {limit?: string};
    return {receipts: await receipts.list(orgId, Number(q.limit ?? 50))};
  });

  app.get("/v1/orgs/:orgId/receipts/verify", async (req) => {
    const {orgId} = req.params as {orgId: string};
    return await receipts.verifyChain(orgId);
  });

  // ================================================================ V10 reputation
  app.get("/v1/vendors/:vendorId/reputation", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    return await reputation.forVendor(assertVendorId(vendorId));
  });

  // ================================================================ V14 discovery
  app.get("/v1/discovery", async (req) => {
    const q = req.query as {category?: string; minLevel?: string; maxRisk?: string; limit?: string};
    return {
      results: await discovery.search({
        ...(q.category ? {category: q.category} : {}),
        ...(q.minLevel ? {minVerificationLevel: Number(q.minLevel)} : {}),
        ...(q.maxRisk ? {maxRiskScore: Number(q.maxRisk)} : {}),
        ...(q.limit ? {limit: Number(q.limit)} : {}),
      }),
    };
  });

  // ================================================================ vetted Bazaar (V14 / x402 discovery)
  app.post("/v1/bazaar/ingest", async (req, reply) => {
    requireAdmin(req);
    const body = req.body as {listings?: BazaarListingInput[]; source?: string};
    if (!Array.isArray(body?.listings)) throw new HttpError(422, "listings[] required");
    const result = await bazaar.ingest(body.listings, body.source ?? "ingest");
    return reply.status(201).send(result);
  });

  app.get("/v1/bazaar/vetted", async (req) => {
    const q = req.query as {minLevel?: string; maxRisk?: string; tag?: string; eligibleOnly?: string; limit?: string};
    return {
      listings: await bazaar.vetted({
        ...(q.minLevel ? {minVerificationLevel: Number(q.minLevel)} : {}),
        ...(q.maxRisk ? {maxRiskScore: Number(q.maxRisk)} : {}),
        ...(q.tag ? {tag: q.tag} : {}),
        ...(q.eligibleOnly === "true" ? {eligibleOnly: true} : {}),
        ...(q.limit ? {limit: Number(q.limit)} : {}),
      }),
    };
  });

  // ================================================================ V2 KYB (level-3 backing)
  app.post("/v1/vendors/:vendorId/kyb", async (req, reply) => {
    requireAdmin(req);
    const {vendorId} = req.params as {vendorId: string};
    const body = (req.body ?? {}) as {legalName?: string; registrationId?: string; jurisdiction?: string};
    const result = await kyb.run(assertVendorId(vendorId), body);
    return reply.status(201).send(result);
  });

  app.get("/v1/vendors/:vendorId/kyb", async (req) => {
    const {vendorId} = req.params as {vendorId: string};
    const latest = await kyb.latest(assertVendorId(vendorId));
    if (!latest) throw new HttpError(404, "no KYB check on record");
    return latest;
  });

  // ================================================================ agent identity / mandate verification (F4)
  app.post("/v1/agents/verify", async (req) => {
    const body = req.body as {agentAuth?: AgentAuth; mandate?: SignedMandate};
    return {
      agent: body?.agentAuth ? {verified: verifyAgentAuth(body.agentAuth), agentId: body.agentAuth.agentId} : null,
      mandate: body?.mandate ? verifyMandate(body.mandate) : null,
    };
  });

  return app;
}

function serializeBudget(b: {id: string; principalId: string; period: string; currency: string; limitMicros: bigint}) {
  return {id: b.id, principalId: b.principalId, period: b.period, currency: b.currency, limit: formatAmount(b.limitMicros)};
}

function assertVendorId(vendorId: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(vendorId)) {
    throw new HttpError(422, "vendorId must be a 0x-prefixed 32-byte hex string");
  }
  return vendorId.toLowerCase();
}
