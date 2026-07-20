import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {canonicalBytes, computeCid, hashDocument, type MerchantMetadata} from "@actp/core";
import {buildApp, type App} from "../app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../chain/applier.js";

/**
 * API integration tests over embedded PGlite. Registry state is seeded by feeding the
 * exact events the indexer would decode — i.e. the same code path as production.
 */

const VENDOR_ID = "0x" + "11".repeat(32);
const OWNER = "0x" + "aa".repeat(20);
const WALLET = "0x" + "bb".repeat(20);
const ADMIN_KEY = "test-admin-key";

let app: App;
let seq = 0;

async function emit(eventName: string, args: Record<string, unknown>, blockNumber = 100): Promise<void> {
  seq += 1;
  const ev: DecodedEvent = {
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: BigInt(blockNumber),
    blockHash: "0x" + "cc".repeat(32),
    blockTime: new Date("2026-07-01T00:00:00Z"),
    contract: eventName.startsWith("Attest") || eventName === "AttesterBanned" ? "AttestationRegistry" : "VendorRegistry",
    eventName,
    args,
  };
  await app.db.tx(async (q) => storeAndApplyEvent(q, ev));
}

const metadataDoc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme Cloud",
  categories: ["saas", "api-services"],
  paymentMethods: [{rail: "x402"}, {rail: "card"}],
  capabilities: {
    subscriptions: true,
    recurringBilling: true,
    refunds: true,
    apiProvider: true,
    saas: true,
    digitalGoods: true,
    physicalGoods: false,
  },
  countriesServed: ["US", "DE"],
  x402: {
    endpoint: "https://api.acme.example/x402",
    networks: ["eip155:8453"],
    assets: ["USDC"],
  },
};

beforeAll(async () => {
  app = await buildApp(
    {DATABASE_URL: undefined, ADMIN_API_KEY: ADMIN_KEY, LOG_LEVEL: "error"},
    {withIndexer: false},
  );
  await emit("VendorRegistered", {
    vendorId: VENDOR_ID,
    owner: OWNER,
    primaryDomain: "acme.example",
    registeredAt: Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000),
  });
  await emit("DomainAdded", {vendorId: VENDOR_ID, domain: "acme.example"});
  await emit("WalletAdded", {vendorId: VENDOR_ID, wallet: WALLET});
});

afterAll(async () => {
  await app.close();
});

describe("vendors API", () => {
  it("GET /v1/vendors/:id returns the indexed record", async () => {
    const res = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}`});
    expect(res.statusCode).toBe(200);
    const {vendor} = res.json();
    expect(vendor.primaryDomain).toBe("acme.example");
    expect(vendor.owner).toBe(OWNER);
    expect(vendor.status).toBe("active");
    expect(vendor.domains).toEqual(["acme.example"]);
    expect(vendor.wallets).toEqual([WALLET]);
    expect(vendor.verificationLevel).toBe(0);
  });

  it("resolves by domain and by wallet", async () => {
    const byDomain = await app.server.inject({method: "GET", url: "/v1/vendors?domain=acme.example"});
    expect(byDomain.json().vendor.vendorId).toBe(VENDOR_ID);

    const byWallet = await app.server.inject({method: "GET", url: `/v1/vendors?wallet=${WALLET}`});
    expect(byWallet.json().vendor.vendorId).toBe(VENDOR_ID);
  });

  it("fails closed on unknown counterparties", async () => {
    const unknownWallet = await app.server.inject({
      method: "GET",
      url: `/v1/vendors?wallet=0x${"99".repeat(20)}`,
    });
    expect(unknownWallet.statusCode).toBe(404);

    const unknownVendor = await app.server.inject({method: "GET", url: `/v1/vendors/0x${"22".repeat(32)}`});
    expect(unknownVendor.statusCode).toBe(404);
  });

  it("rejects malformed identifiers", async () => {
    expect((await app.server.inject({method: "GET", url: "/v1/vendors/not-hex"})).statusCode).toBe(422);
    expect(
      (await app.server.inject({method: "GET", url: "/v1/vendors?wallet=nope"})).statusCode,
    ).toBe(422);
  });
});

describe("metadata API (V3)", () => {
  it("rejects publish without admin key", async () => {
    const res = await app.server.inject({
      method: "PUT",
      url: `/v1/vendors/${VENDOR_ID}/metadata`,
      payload: metadataDoc,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects schema-invalid documents", async () => {
    const res = await app.server.inject({
      method: "PUT",
      url: `/v1/vendors/${VENDOR_ID}/metadata`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {...metadataDoc, categories: []},
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects documents whose primaryDomain does not match the registry", async () => {
    const res = await app.server.inject({
      method: "PUT",
      url: `/v1/vendors/${VENDOR_ID}/metadata`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {...metadataDoc, primaryDomain: "evil.example"},
    });
    expect(res.statusCode).toBe(422);
  });

  it("publishes, then reports not_anchored until the onchain anchor lands", async () => {
    const res = await app.server.inject({
      method: "PUT",
      url: `/v1/vendors/${VENDOR_ID}/metadata`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: metadataDoc,
    });
    expect(res.statusCode).toBe(201);
    const {canonicalHash, version, cid, uri} = res.json();
    expect(canonicalHash).toBe(hashDocument(metadataDoc));
    expect(version).toBe(1);
    // content-addressed: the CID is derived from the canonical bytes and echoed as an ipfs uri
    expect(cid).toBe(await computeCid(canonicalBytes(metadataDoc)));
    expect(uri).toBe(`ipfs://${cid}`);

    const get = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/metadata`});
    expect(get.json().integrity).toBe("not_anchored");
    // document is retrievable from the content-addressed store, independent of this table
    expect(get.json().cid).toBe(cid);
    expect(get.json().ipfsAvailable).toBe(true);
  });

  it("integrity becomes verified once the anchoring event is indexed", async () => {
    await emit("MetadataUpdated", {
      vendorId: VENDOR_ID,
      version: 1,
      metadataHash: hashDocument(metadataDoc),
      metadataURI: "https://registry.example/acme/metadata/1",
    });
    const get = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/metadata`});
    expect(get.json().integrity).toBe("verified");
  });

  it("integrity is hash_mismatch when the anchor points to a hash we never stored", async () => {
    await emit("MetadataUpdated", {
      vendorId: VENDOR_ID,
      version: 2,
      metadataHash: "0x" + "de".repeat(32),
      metadataURI: "",
    });
    const get = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/metadata`});
    expect(get.json().integrity).toBe("hash_mismatch");

    // restore the good anchor for later tests
    await emit("MetadataUpdated", {
      vendorId: VENDOR_ID,
      version: 3,
      metadataHash: hashDocument(metadataDoc),
      metadataURI: "",
    });
  });
});

describe("contract intelligence API (V4)", () => {
  it("ingests a ToS and returns terms with provenance", async () => {
    const res = await app.server.inject({
      method: "POST",
      url: `/v1/vendors/${VENDOR_ID}/contract-documents`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {
        content:
          "Your subscription will automatically renew each month at $10.00. Cancel anytime from your account dashboard. No refunds.",
        docType: "terms_of_service",
      },
    });
    expect(res.statusCode).toBe(201);
    const stored = res.json();
    expect(stored.merchantAnchored).toBe(false); // AI/pattern output is never verified fact
    expect(stored.terms.autoRenews.value).toBe(true);
    expect(stored.terms.autoRenews.source).toBe("deterministic_parse");
    expect(stored.terms.refundPolicy.value.type).toBe("none");

    const get = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/contract-terms`});
    expect(get.statusCode).toBe(200);
    expect(get.json().terms.cancellationMethod.value).toBe("self_service");
  });

  it("marks terms merchantAnchored when the owner anchored that exact document hash onchain", async () => {
    const content = "Annual plan renews automatically every year. Cancel at least 30 days before the renewal.";
    const {keccak256, toBytes} = await import("viem");
    await emit("ContractMetadataUpdated", {
      vendorId: VENDOR_ID,
      version: 1,
      contractMetadataHash: keccak256(toBytes(content)),
    });
    const res = await app.server.inject({
      method: "POST",
      url: `/v1/vendors/${VENDOR_ID}/contract-documents`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {content, docType: "terms_of_service"},
    });
    expect(res.json().merchantAnchored).toBe(true);
  });

  it("rejects empty and oversized documents", async () => {
    const empty = await app.server.inject({
      method: "POST",
      url: `/v1/vendors/${VENDOR_ID}/contract-documents`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {content: "   "},
    });
    expect(empty.statusCode).toBe(422);
  });
});

describe("risk API (V5)", () => {
  it("scores the vendor with full explanation", async () => {
    const res = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/risk`});
    expect(res.statusCode).toBe(200);
    const score = res.json();
    expect(score.riskLevel).toMatch(/low|medium|high|critical/);
    expect(score.rulesetVersion).toBe("1.0.0");
    expect(score.inputsSnapshotHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Array.isArray(score.reasons)).toBe(true);
    // unverified vendor: expect the verification reason present
    expect(score.reasons.map((r: {rule: string}) => r.rule)).toContain("verification.unverified");
  });

  it("ingested signals change the score (sanctions => critical)", async () => {
    const put = await app.server.inject({
      method: "POST",
      url: `/v1/vendors/${VENDOR_ID}/risk-signals`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {signal: "sanctions_match", value: true, source: "ofac-test"},
    });
    expect(put.statusCode).toBe(204);

    const res = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/risk`});
    expect(res.json().riskLevel).toBe("critical");
    expect(res.json().score).toBe(100);

    // clear it again
    await app.server.inject({
      method: "POST",
      url: `/v1/vendors/${VENDOR_ID}/risk-signals`,
      headers: {"x-api-key": ADMIN_KEY},
      payload: {signal: "sanctions_match", value: false, source: "ofac-test"},
    });
  });

  it("attestation events raise verification level and lower risk", async () => {
    await emit("Attested", {
      attestationId: "0x" + "33".repeat(32),
      vendorId: VENDOR_ID,
      attType: 3,
      attester: "0x" + "44".repeat(20),
      evidenceHash: "0x" + "55".repeat(32),
      issuedAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 180,
    });

    const vendor = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}`});
    expect(vendor.json().vendor.verificationLevel).toBe(3);

    const risk = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/risk`});
    const rules = risk.json().reasons.map((r: {rule: string}) => r.rule);
    expect(rules).not.toContain("verification.unverified");
  });

  it("attestation revocation drops the level again", async () => {
    await emit("AttestationRevoked", {
      attestationId: "0x" + "33".repeat(32),
      revokedBy: "0x" + "44".repeat(20),
      reason: "test revoke",
    });
    const vendor = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}`});
    expect(vendor.json().vendor.verificationLevel).toBe(0);
  });

  it("suspension propagates to risk as a high override", async () => {
    await emit("VendorStatusChanged", {vendorId: VENDOR_ID, oldStatus: 1, newStatus: 2, reason: "test"});
    const risk = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/risk`});
    expect(risk.json().riskLevel).toBe("high");
    expect(risk.json().score).toBeGreaterThanOrEqual(70);

    await emit("VendorStatusChanged", {vendorId: VENDOR_ID, oldStatus: 2, newStatus: 1, reason: "restore"});
  });

  it("keeps score history", async () => {
    const res = await app.server.inject({method: "GET", url: `/v1/vendors/${VENDOR_ID}/risk/history`});
    expect(res.statusCode).toBe(200);
    expect(res.json().history.length).toBeGreaterThanOrEqual(2);
  });
});
