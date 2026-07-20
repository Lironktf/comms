import Fastify, {type FastifyInstance} from "fastify";
import {ZodError} from "zod";
import type {AppConfig} from "../config.js";
import type {Db} from "../db/client.js";
import {computeCid, isValidCid} from "@actp/core";
import {HttpError, MetadataService} from "../services/metadata.js";
import {VendorService} from "../services/vendors.js";
import {ContractIntelService} from "../services/contractIntel/service.js";
import {RiskEngine} from "../services/risk/engine.js";
import type {IpfsStore} from "../storage/ipfs.js";

export interface AppServices {
  db: Db;
  vendors: VendorService;
  metadata: MetadataService;
  contractIntel: ContractIntelService;
  risk: RiskEngine;
  ipfs: IpfsStore;
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
  const {vendors, metadata, contractIntel, risk, ipfs} = services;

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

  return app;
}

function assertVendorId(vendorId: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(vendorId)) {
    throw new HttpError(422, "vendorId must be a 0x-prefixed 32-byte hex string");
  }
  return vendorId.toLowerCase();
}
