import {generateKeyPairSync, sign} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {canonicalize, hashDocument, parsePolicyText, type AgentAuth, type MerchantMetadata} from "@actp/core";
import {buildApp, type App} from "../app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../chain/applier.js";

const VENDOR_ID = "0x" + "22".repeat(32);
const ADMIN = "f4-admin";

let app: App;
let agentId: string;
let seq = 0;

async function emit(name: string, args: Record<string, unknown>) {
  seq += 1;
  const ev: DecodedEvent = {
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: BigInt(100 + seq),
    blockHash: "0x" + "cc".repeat(32),
    blockTime: new Date("2025-06-01").toISOString() as unknown as Date,
    contract: name.startsWith("Attest") ? "AttestationRegistry" : "VendorRegistry",
    eventName: name,
    args,
  };
  await app.db.tx(async (q) => storeAndApplyEvent(q, {...ev, blockTime: new Date("2025-06-01T00:00:00Z")}));
}

const doc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme",
  categories: ["software"],
  paymentMethods: [{rail: "x402"}],
  capabilities: {subscriptions: false, recurringBilling: false, refunds: true, apiProvider: true, saas: true, digitalGoods: true, physicalGoods: false},
};

function inject(method: string, url: string, payload?: unknown, admin = false) {
  return app.server.inject({method: method as never, url, ...(payload ? {payload} : {}), ...(admin ? {headers: {"x-api-key": ADMIN}} : {})});
}

beforeAll(async () => {
  app = await buildApp({DATABASE_URL: undefined, ADMIN_API_KEY: ADMIN, LOG_LEVEL: "error"}, {withIndexer: false});
  await emit("VendorRegistered", {vendorId: VENDOR_ID, owner: "0x" + "aa".repeat(20), primaryDomain: "acme.example", registeredAt: Math.floor(new Date("2025-01-01").getTime() / 1000)});
  await emit("DomainAdded", {vendorId: VENDOR_ID, domain: "acme.example"});
  await emit("MetadataUpdated", {vendorId: VENDOR_ID, version: 1, metadataHash: hashDocument(doc), metadataURI: "ipfs://x"});
  await emit("Attested", {attestationId: "0x" + "33".repeat(32), vendorId: VENDOR_ID, attType: 3, attester: "0x" + "44".repeat(20), evidenceHash: "0x" + "55".repeat(32), issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 86400 * 180});
  await app.services.metadata.publish(VENDOR_ID, doc);

  const org = await app.services.principals.createOrg("Acme");
  const agent = await app.services.principals.createChild(org.id, "agent", "Bot");
  agentId = agent.id;
  // policy REQUIRES a verified agent identity for a purchase to be allowed
  await app.services.principals.setPolicy(
    org.id,
    parsePolicyText(
      `[require-verified-agent] deny when agent.verified == false\nallow when vendor.verificationLevel >= 3 and category in ["software"]`,
      {version: "1.0.0"},
    ),
  );
  await app.services.budgets.createBudget(org.id, "total", "USD", "1000");
});

afterAll(async () => {
  await app.close();
});

describe("F4 — agent identity gates a decision", () => {
  function agentAuth(): AgentAuth {
    const {publicKey, privateKey} = generateKeyPairSync("ed25519");
    const nonce = "nonce-1";
    return {
      agentId,
      publicKeyPem: publicKey.export({type: "spki", format: "pem"}).toString(),
      nonce,
      signature: sign(null, Buffer.from(`${agentId}.${nonce}`), privateKey).toString("base64url"),
    };
  }

  it("DENIES when no verified agent identity is presented", async () => {
    const res = await inject("POST", "/v1/decisions", {
      requestId: "f4-1",
      principal: {agentId},
      rail: "x402",
      amount: {value: "3", currency: "USDC"},
      payee: {vendorId: VENDOR_ID},
      category: "software",
    });
    expect(res.json().outcome).toBe("deny");
    expect(res.json().reasons.some((r: {rule: string}) => r.rule === "require-verified-agent")).toBe(true);
  });

  it("ALLOWS when a valid agent identity signature is attached", async () => {
    const res = await inject("POST", "/v1/decisions", {
      requestId: "f4-2",
      principal: {agentId},
      rail: "x402",
      amount: {value: "3", currency: "USDC"},
      payee: {vendorId: VENDOR_ID},
      category: "software",
      agentAuth: agentAuth(),
    });
    expect(res.json().outcome).toBe("allow");
    expect(res.json().token).toBeTruthy();
  });

  it("verifies agent + mandate over the API", async () => {
    const res = await inject("POST", "/v1/agents/verify", {agentAuth: agentAuth()});
    expect(res.json().agent.verified).toBe(true);
  });
});

describe("F4 — KYB produces an onchain level-3 attestation input", () => {
  it("passes KYB with an LEI and returns an attestation input for a verifier to submit", async () => {
    const res = await inject("POST", `/v1/vendors/${VENDOR_ID}/kyb`, {legalName: "Acme Inc", registrationId: "5493001KJTIIGC8Y1R12"}, true);
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r.passed).toBe(true);
    expect(r.attestationInput).toMatchObject({vendorId: VENDOR_ID.toLowerCase(), attType: 3});
    expect(r.attestationInput.evidenceHash).toBe(r.evidenceHash);
  });

  it("fails KYB without a legal-entity identifier (no attestation input)", async () => {
    const res = await inject("POST", `/v1/vendors/${VENDOR_ID}/kyb`, {legalName: "Acme"}, true);
    expect(res.json().passed).toBe(false);
    expect(res.json().attestationInput).toBeNull();
  });
});
