import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {hashDocument, parsePolicyText, type MerchantMetadata} from "@actp/core";
import {ActpClient} from "@actp/sdk";
import {buildApp, type App} from "../../backend/src/app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../../backend/src/chain/applier.js";
import {ACTP_TOOLS} from "./tools.js";

/**
 * Tests the MCP tool handlers against an in-process ACTP backend. The ActpClient's fetch is
 * routed through Fastify's inject(), so there's no network but the full API path is exercised.
 */

const VENDOR_ID = "0x" + "11".repeat(32);
const WALLET = "0x" + "bb".repeat(20);

let app: App;
let client: ActpClient;
let agentId: string;
let seq = 0;

async function emit(eventName: string, args: Record<string, unknown>): Promise<void> {
  seq += 1;
  const ev: DecodedEvent = {
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: BigInt(100 + seq),
    blockHash: "0x" + "cc".repeat(32),
    blockTime: new Date("2025-06-01T00:00:00Z"),
    contract: eventName.startsWith("Attest") ? "AttestationRegistry" : "VendorRegistry",
    eventName,
    args,
  };
  await app.db.tx(async (q) => storeAndApplyEvent(q, ev));
}

const metadataDoc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme Cloud",
  categories: ["software"],
  paymentMethods: [{rail: "x402"}],
  capabilities: {subscriptions: false, recurringBilling: false, refunds: true, apiProvider: true, saas: true, digitalGoods: true, physicalGoods: false},
};

function tool(name: string) {
  const t = ACTP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeAll(async () => {
  app = await buildApp({DATABASE_URL: undefined, ADMIN_API_KEY: undefined, LOG_LEVEL: "error"}, {withIndexer: false});

  await emit("VendorRegistered", {
    vendorId: VENDOR_ID,
    owner: "0x" + "aa".repeat(20),
    primaryDomain: "acme.example",
    registeredAt: Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000),
  });
  await emit("DomainAdded", {vendorId: VENDOR_ID, domain: "acme.example"});
  await emit("WalletAdded", {vendorId: VENDOR_ID, wallet: WALLET});
  await emit("MetadataUpdated", {vendorId: VENDOR_ID, version: 1, metadataHash: hashDocument(metadataDoc), metadataURI: "ipfs://x"});
  await emit("Attested", {
    attestationId: "0x" + "33".repeat(32),
    vendorId: VENDOR_ID,
    attType: 3,
    attester: "0x" + "44".repeat(20),
    evidenceHash: "0x" + "55".repeat(32),
    issuedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 86400 * 180,
  });
  await app.services.metadata.publish(VENDOR_ID, metadataDoc);

  const org = await app.services.principals.createOrg("Acme");
  const agent = await app.services.principals.createChild(org.id, "agent", "Bot");
  agentId = agent.id;
  await app.services.principals.setPolicy(
    org.id,
    parsePolicyText(`allow when vendor.verificationLevel >= 3 and category in ["software"]`, {version: "1.0.0"}),
  );
  await app.services.budgets.createBudget(org.id, "total", "USD", "1000");

  // route the SDK's fetch through Fastify inject (no network)
  const injectFetch = (async (url: string, init?: {method?: string; body?: string; headers?: Record<string, string>}) => {
    const parsed = new URL(url);
    const res = await app.server.inject({
      method: (init?.method ?? "GET") as never,
      url: parsed.pathname + parsed.search,
      ...(init?.body ? {payload: JSON.parse(init.body)} : {}),
      ...(init?.headers ? {headers: init.headers} : {}),
    });
    return new Response(res.statusCode === 204 ? null : res.payload, {
      status: res.statusCode,
      headers: {"content-type": "application/json"},
    });
  }) as unknown as typeof fetch;

  client = new ActpClient({apiUrl: "http://actp.local", fetchFn: injectFetch});
});

afterAll(async () => {
  await app.close();
});

describe("ACTP MCP tools", () => {
  it("exposes the expected tool set with schemas", () => {
    expect(ACTP_TOOLS.map((t) => t.name)).toEqual([
      "actp_resolve_merchant",
      "actp_get_risk",
      "actp_verified_metadata",
      "actp_decide",
      "actp_discover",
    ]);
    for (const t of ACTP_TOOLS) expect(Object.keys(t.schema.shape).length).toBeGreaterThan(0);
  });

  it("resolve_merchant returns the registered vendor", async () => {
    const r = await tool("actp_resolve_merchant").handler(client, {domain: "acme.example"});
    expect((r.data as {vendorId: string}).vendorId).toBe(VENDOR_ID.toLowerCase());
    expect(r.summary).toMatch(/level 3/);
  });

  it("resolve_merchant fails closed on unknown counterparties", async () => {
    const r = await tool("actp_resolve_merchant").handler(client, {wallet: "0x" + "99".repeat(20)});
    expect(r.data).toBeNull();
    expect(r.summary).toMatch(/UNKNOWN|fail closed/i);
  });

  it("get_risk returns an explainable score", async () => {
    const r = await tool("actp_get_risk").handler(client, {vendorId: VENDOR_ID});
    expect(r.data).toHaveProperty("riskLevel");
    expect(r.summary).toMatch(/Risk:/);
  });

  it("verified_metadata reports the trust status", async () => {
    const r = await tool("actp_verified_metadata").handler(client, {vendorId: VENDOR_ID});
    expect(r.summary).toMatch(/VERIFIED|NOT trusted/);
  });

  it("decide returns an allow with an enforcement token", async () => {
    const r = await tool("actp_decide").handler(client, {
      requestId: "mcp-1",
      agentId,
      rail: "x402",
      amountValue: "3",
      amountCurrency: "USDC",
      payeeVendorId: VENDOR_ID,
      category: "software",
    });
    const d = r.data as {outcome: string; token: string | null};
    expect(d.outcome).toBe("allow");
    expect(d.token).toBeTruthy();
    expect(r.summary).toMatch(/ALLOW/);
  });

  it("discover returns ranked trusted merchants", async () => {
    const r = await tool("actp_discover").handler(client, {category: "software", minVerificationLevel: 3});
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});
