import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {hashDocument, type MerchantMetadata} from "@actp/core";
import {buildApp, type App} from "../app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../chain/applier.js";

/**
 * Integrity is checked on every read and never trusted from storage. These tests attack the
 * offchain layer directly: a compromised backend database that serves a tampered document
 * must be detected, because the recomputed hash won't match — that's the whole point of
 * anchoring the hash onchain.
 */

const VENDOR_ID = "0x" + "ab".repeat(32);
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
    contract: "VendorRegistry",
    eventName: name,
    args,
  };
  await app.db.tx(async (q) => storeAndApplyEvent(q, ev));
}

const doc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme Cloud",
  categories: ["software"],
  paymentMethods: [{rail: "x402"}],
  capabilities: {subscriptions: false, recurringBilling: false, refunds: true, apiProvider: true, saas: true, digitalGoods: true, physicalGoods: false},
};

beforeAll(async () => {
  app = await buildApp({DATABASE_URL: undefined, LOG_LEVEL: "error"}, {withIndexer: false});
  await emit("VendorRegistered", {vendorId: VENDOR_ID, owner: "0x" + "aa".repeat(20), primaryDomain: "acme.example", registeredAt: Math.floor(new Date("2025-01-01").getTime() / 1000)});
  await emit("DomainAdded", {vendorId: VENDOR_ID, domain: "acme.example"});
});

afterAll(async () => {
  await app.close();
});

describe("metadata integrity", () => {
  it("reports no_document before anything is published", async () => {
    expect(await app.services.metadata.integrityStatus(VENDOR_ID)).toBe("no_document");
  });

  it("reports not_anchored after publish but before the onchain anchor", async () => {
    await app.services.metadata.publish(VENDOR_ID, doc);
    const latest = await app.services.metadata.getLatest(VENDOR_ID);
    expect(latest!.integrity).toBe("not_anchored");
    expect(latest!.ipfsAvailable).toBe(true); // stored content-addressed
  });

  it("reports verified once the onchain anchor matches", async () => {
    await emit("MetadataUpdated", {vendorId: VENDOR_ID, version: 1, metadataHash: hashDocument(doc), metadataURI: "ipfs://x"});
    const latest = await app.services.metadata.getLatest(VENDOR_ID);
    expect(latest!.integrity).toBe("verified");
    expect(latest!.canonicalHash).toBe(hashDocument(doc));
  });

  it("detects a compromised database: tampered stored bytes => hash_mismatch, even with a matching anchor", async () => {
    // simulate an attacker editing the stored document row directly (keeping the recorded hash)
    const tampered = {...doc, displayName: "Totally Legit Acme (definitely not evil)"};
    await app.db.query(`UPDATE metadata_documents SET document = $2 WHERE vendor_id = $1`, [
      VENDOR_ID.toLowerCase(),
      JSON.stringify(tampered),
    ]);
    const latest = await app.services.metadata.getLatest(VENDOR_ID);
    // recomputed hash of the tampered doc no longer matches the stored canonical_hash
    expect(latest!.integrity).toBe("hash_mismatch");
  });
});
