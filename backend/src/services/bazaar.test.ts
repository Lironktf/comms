import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {hashDocument, type MerchantMetadata} from "@actp/core";
import {buildApp, type App} from "../app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../chain/applier.js";

const VENDOR_ID = "0x" + "77".repeat(32);
const WALLET = "0x" + "cc".repeat(20);

let app: App;
let seq = 0;

async function emit(name: string, args: Record<string, unknown>) {
  seq += 1;
  const ev: DecodedEvent = {
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: BigInt(100 + seq),
    blockHash: "0x" + "cc".repeat(32),
    blockTime: new Date("2025-06-01T00:00:00Z"),
    contract: name.startsWith("Attest") ? "AttestationRegistry" : "VendorRegistry",
    eventName: name,
    args,
  };
  await app.db.tx(async (q) => storeAndApplyEvent(q, ev));
}

const doc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "data.example",
  displayName: "Data Co",
  categories: ["api-services"],
  paymentMethods: [{rail: "x402"}],
  capabilities: {subscriptions: false, recurringBilling: false, refunds: false, apiProvider: true, saas: false, digitalGoods: true, physicalGoods: false},
};

beforeAll(async () => {
  app = await buildApp({DATABASE_URL: undefined, LOG_LEVEL: "error"}, {withIndexer: false});
  await emit("VendorRegistered", {vendorId: VENDOR_ID, owner: "0x" + "aa".repeat(20), primaryDomain: "data.example", registeredAt: Math.floor(new Date("2025-01-01").getTime() / 1000)});
  await emit("DomainAdded", {vendorId: VENDOR_ID, domain: "data.example"});
  await emit("WalletAdded", {vendorId: VENDOR_ID, wallet: WALLET});
  await emit("MetadataUpdated", {vendorId: VENDOR_ID, version: 1, metadataHash: hashDocument(doc), metadataURI: "ipfs://x"});
  await emit("Attested", {attestationId: "0x" + "33".repeat(32), vendorId: VENDOR_ID, attType: 3, attester: "0x" + "44".repeat(20), evidenceHash: "0x" + "55".repeat(32), issuedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 86400 * 180});

  await app.services.bazaar.ingest([
    {resourceUrl: "https://data.example/api", payTo: WALLET, serviceName: "Data feed", tags: ["data", "api"], price: {amount: "0.01", currency: "USDC"}},
    {resourceUrl: "https://sketchy.example/api", payTo: "0x" + "99".repeat(20), serviceName: "Mystery feed", tags: ["data"]},
  ]);
});

afterAll(async () => {
  await app.close();
});

describe("vetted Bazaar", () => {
  it("marks a registered, verified, low-risk merchant eligible", async () => {
    const listings = await app.services.bazaar.vetted();
    const known = listings.find((l) => l.resourceUrl === "https://data.example/api");
    expect(known).toBeDefined();
    expect(known!.vendorId).toBe(VENDOR_ID.toLowerCase());
    expect(known!.verificationLevel).toBe(3);
    expect(known!.eligibleForAgentPurchase).toBe(true);
  });

  it("flags an unregistered merchant ineligible with a reason", async () => {
    const listings = await app.services.bazaar.vetted();
    const unknown = listings.find((l) => l.resourceUrl === "https://sketchy.example/api");
    expect(unknown!.vendorId).toBeNull();
    expect(unknown!.eligibleForAgentPurchase).toBe(false);
    expect(unknown!.reasons).toContain("merchant.unregistered");
  });

  it("ranks eligible merchants ahead of ineligible ones", async () => {
    const listings = await app.services.bazaar.vetted();
    const known = listings.find((l) => l.eligibleForAgentPurchase);
    const unknown = listings.find((l) => !l.eligibleForAgentPurchase);
    expect(known!.rank).toBeLessThan(unknown!.rank);
  });

  it("eligibleOnly filters out the unregistered listing", async () => {
    const listings = await app.services.bazaar.vetted({eligibleOnly: true});
    expect(listings.every((l) => l.eligibleForAgentPurchase)).toBe(true);
    expect(listings.some((l) => l.resourceUrl === "https://sketchy.example/api")).toBe(false);
  });

  it("minVerificationLevel excludes merchants below the bar", async () => {
    const listings = await app.services.bazaar.vetted({minVerificationLevel: 5, eligibleOnly: false});
    const known = listings.find((l) => l.resourceUrl === "https://data.example/api");
    expect(known!.eligibleForAgentPurchase).toBe(false); // level 3 < 5
    expect(known!.reasons.some((r) => r.startsWith("verification.below_min"))).toBe(true);
  });

  it("exposes the vetted feed over the API", async () => {
    const res = await app.server.inject({method: "GET", url: "/v1/bazaar/vetted?eligibleOnly=true"});
    expect(res.statusCode).toBe(200);
    expect(res.json().listings.length).toBeGreaterThanOrEqual(1);
  });
});
