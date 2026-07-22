/**
 * ACTP backend for the live x402 demo.
 *
 * Runs the real decision engine on an in-memory PGlite database, seeds one verified merchant
 * (whose payTo wallet is the demo seller's receiving address) plus an org → agent principal
 * with a spending policy, then serves the REST API. The x402 payer (pay.ts) calls
 * POST /v1/decisions/rail/x402 against this before it signs any payment.
 *
 * The merchant is seeded exactly the way the indexer would project it from chain events
 * (VendorRegistered / DomainAdded / WalletAdded / Attested) — so the decision is produced by
 * the same code path a mainnet deployment uses, just without waiting on a live indexer.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {keccak256, toBytes} from "viem";
import {parsePolicyText} from "@actp/core";
import {buildApp} from "../../backend/src/app.js";
import {storeAndApplyEvent, type DecodedEvent} from "../../backend/src/chain/applier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACTP_PORT ?? 8080);
const DOMAIN = "acme-cloud.example";

function envFromFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const wallet = envFromFile(join(HERE, ".wallet.testnet.env"));
const sellerAddress = (process.env.SELLER_ADDRESS ?? wallet.SELLER_ADDRESS ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(sellerAddress)) {
  throw new Error("SELLER_ADDRESS missing/invalid — run the setup step first");
}

const vendorId = keccak256(toBytes(DOMAIN)); // deterministic 32-byte id
const attester = "0x" + "11".repeat(20);
const nowUnix = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => nowUnix - d * 86_400;
const inDays = (d: number) => nowUnix + d * 86_400;

let seq = 0;
function ev(name: string, contract: DecodedEvent["contract"], args: Record<string, unknown>): DecodedEvent {
  seq += 1;
  return {
    txHash: "0x" + seq.toString(16).padStart(64, "0"),
    logIndex: 0,
    blockNumber: BigInt(1000 + seq),
    blockHash: "0x" + "cc".repeat(32),
    blockTime: new Date(),
    contract,
    eventName: name,
    args,
  };
}

async function main() {
  const app = await buildApp(
    {DATABASE_URL: undefined, LOG_LEVEL: "warn", ADMIN_API_KEY: undefined},
    {withIndexer: false},
  );

  // --- seed the merchant exactly as the indexer would project it from chain ---
  await app.db.tx(async (q) => {
    await storeAndApplyEvent(q, ev("VendorRegistered", "VendorRegistry", {
      vendorId, owner: "0x" + "ab".repeat(20), primaryDomain: DOMAIN, registeredAt: daysAgo(120),
    }));
    await storeAndApplyEvent(q, ev("DomainAdded", "VendorRegistry", {vendorId, domain: DOMAIN}));
    await storeAndApplyEvent(q, ev("WalletAdded", "VendorRegistry", {vendorId, wallet: sellerAddress}));
    // two live attestations → verification level 3 (LegalEntityVerified)
    await storeAndApplyEvent(q, ev("Attested", "AttestationRegistry", {
      attestationId: keccak256(toBytes("att-domain")), vendorId, attType: 1 /* DomainVerified */,
      evidenceHash: keccak256(toBytes("domain-evidence")), issuedAt: daysAgo(100), expiresAt: inDays(265), attester,
    }));
    await storeAndApplyEvent(q, ev("Attested", "AttestationRegistry", {
      attestationId: keccak256(toBytes("att-kyb")), vendorId, attType: 3 /* LegalEntityVerified */,
      evidenceHash: keccak256(toBytes("kyb-evidence")), issuedAt: daysAgo(90), expiresAt: inDays(275), attester,
    }));
  });

  // --- principals: org → agent, with a spending policy and a monthly budget ---
  const org = await app.services.principals.createOrg("Acme Robotics (demo)");
  const agent = await app.services.principals.createChild(org.id, "agent", "research-agent-01");

  const policyText = [
    "# demo spending policy — deny-by-default",
    "[deny-unknown] deny when vendor.known == false",
    "[deny-inactive] deny when vendor.status != \"active\"",
    "[step-up-large] require_approval when amount > 5",
    "[allow-verified] allow when vendor.verificationLevel >= 2",
  ].join("\n");
  const policy = parsePolicyText(policyText, {version: "1.0.0", normalizedCurrency: "USD"});
  await app.services.principals.setPolicy(agent.id, policy);
  await app.services.budgets.createBudget(agent.id, "month", "USD", "500");

  const apiUrl = `http://127.0.0.1:${PORT}`;
  writeFileSync(join(HERE, ".demo-state.json"), JSON.stringify({
    apiUrl, orgId: org.id, agentId: agent.id, vendorId, domain: DOMAIN, sellerAddress,
    policyText,
  }, null, 2));

  await app.server.listen({port: PORT, host: "127.0.0.1"});
  console.log(`\n[actp] decision API listening on ${apiUrl}`);
  console.log(`[actp] seeded merchant vendorId=${vendorId}`);
  console.log(`[actp]   payTo wallet=${sellerAddress}  domain=${DOMAIN}  verificationLevel=3`);
  console.log(`[actp] principal agentId=${agent.id} (org ${org.id})`);
  console.log(`[actp] policy:\n${policyText.split("\n").map((l) => "        " + l).join("\n")}`);
  console.log(`[actp] state written to .demo-state.json — ready for the seller + payer.\n`);

  process.on("SIGINT", async () => { await app.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await app.close(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
