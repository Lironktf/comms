import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createDb, type Db} from "../db/client.js";
import {migrate} from "../db/migrations.js";
import {rebuildDerivedState, storeAndApplyEvent, type DecodedEvent} from "./applier.js";

let db: Db;
let seq = 0;

function ev(eventName: string, args: Record<string, unknown>, block = 10): DecodedEvent {
  seq += 1;
  return {
    txHash: `0x${seq.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: BigInt(block),
    blockHash: "0x" + "ee".repeat(32),
    blockTime: new Date("2026-07-01T00:00:00Z"),
    contract: "VendorRegistry",
    eventName,
    args,
  };
}

const V = "0x" + "77".repeat(32);

beforeAll(async () => {
  db = await createDb();
  await migrate(db);
});

afterAll(async () => {
  await db.close();
});

describe("event applier", () => {
  it("applies a registration sequence into derived tables", async () => {
    await db.tx(async (q) => {
      await storeAndApplyEvent(q, ev("VendorRegistered", {vendorId: V, owner: "0xAA", primaryDomain: "x.example", registeredAt: 1_700_000_000}));
      await storeAndApplyEvent(q, ev("DomainAdded", {vendorId: V, domain: "x.example"}));
      await storeAndApplyEvent(q, ev("WalletAdded", {vendorId: V, wallet: "0xBB"}));
      await storeAndApplyEvent(q, ev("X402EndpointUpdated", {vendorId: V, endpoint: "https://x.example/x402"}));
    });

    const vendor = await db.query(`SELECT * FROM vendors WHERE vendor_id = $1`, [V]);
    expect(vendor.rows[0]?.status).toBe("active");
    expect(vendor.rows[0]?.x402_endpoint).toBe("https://x.example/x402");
    const domains = await db.query(`SELECT * FROM vendor_domains WHERE vendor_id = $1`, [V]);
    expect(domains.rows).toHaveLength(1);
  });

  it("is idempotent: replaying the same (txHash, logIndex) is a no-op", async () => {
    const duplicate = ev("WalletAdded", {vendorId: V, wallet: "0xCC"});
    await db.tx(async (q) => {
      await storeAndApplyEvent(q, duplicate);
      await storeAndApplyEvent(q, duplicate);
    });
    const wallets = await db.query(`SELECT * FROM vendor_wallets WHERE vendor_id = $1`, [V]);
    expect(wallets.rows).toHaveLength(2); // 0xbb + 0xcc, no dupes
  });

  it("rebuildDerivedState reproduces identical state from the event log (reorg recovery)", async () => {
    const before = {
      vendors: (await db.query(`SELECT * FROM vendors ORDER BY vendor_id`)).rows,
      domains: (await db.query(`SELECT * FROM vendor_domains ORDER BY domain`)).rows,
      wallets: (await db.query(`SELECT * FROM vendor_wallets ORDER BY wallet`)).rows,
    };

    await rebuildDerivedState(db);

    const after = {
      vendors: (await db.query(`SELECT * FROM vendors ORDER BY vendor_id`)).rows,
      domains: (await db.query(`SELECT * FROM vendor_domains ORDER BY domain`)).rows,
      wallets: (await db.query(`SELECT * FROM vendor_wallets ORDER BY wallet`)).rows,
    };
    expect(after).toEqual(before);
  });

  it("domain removal releases the claim", async () => {
    await db.tx(async (q) => {
      await storeAndApplyEvent(q, ev("DomainAdded", {vendorId: V, domain: "shop.x.example"}));
      await storeAndApplyEvent(q, ev("DomainRemoved", {vendorId: V, domain: "shop.x.example"}));
    });
    const domains = await db.query(`SELECT * FROM vendor_domains WHERE domain = $1`, ["shop.x.example"]);
    expect(domains.rows).toHaveLength(0);
  });

  it("ownership transfer updates the owner", async () => {
    await db.tx(async (q) => {
      await storeAndApplyEvent(q, ev("VendorOwnershipTransferred", {vendorId: V, oldOwner: "0xAA", newOwner: "0xDD"}));
    });
    const vendor = await db.query(`SELECT owner FROM vendors WHERE vendor_id = $1`, [V]);
    expect(vendor.rows[0]?.owner).toBe("0xdd");
  });

  it("attester bans are recorded", async () => {
    await db.tx(async (q) => {
      await storeAndApplyEvent(q, {
        ...ev("AttesterBanned", {attester: "0xEE", issuedAtCutoff: 1_750_000_000}),
        contract: "AttestationRegistry",
      });
    });
    const bans = await db.query(`SELECT * FROM attester_bans WHERE attester = $1`, ["0xee"]);
    expect(bans.rows).toHaveLength(1);
  });
});
