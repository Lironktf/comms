import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {execFileSync, spawn, type ChildProcess} from "node:child_process";
import {readFileSync, rmSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  createTestClient,
  createWalletClient,
  http,
  publicActions,
  type Address,
  type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {foundry} from "viem/chains";
import {attestationRegistryAbi, type MerchantMetadata} from "@actp/core";
import {ActpClient} from "@actp/sdk";
import {buildApp, type App} from "../app.js";

/**
 * End-to-end: anvil -> forge deploy script -> indexer -> REST API -> SDK.
 *
 * Exercises the complete V1–V5 flow the way a real integrator would:
 * register -> verify (attestations) -> publish + anchor metadata -> vendor-sign ->
 * contract intelligence -> risk -> guardian suspension failing closed.
 */

const RPC_PORT = 18545;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const FORGE = process.env.FORGE_BIN ?? `${process.env.HOME}/.foundry/bin/forge`;
const ANVIL = process.env.ANVIL_BIN ?? `${process.env.HOME}/.foundry/bin/anvil`;

// anvil's deterministic accounts
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // #0
const VERIFIER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // #1
const VENDOR_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // #2

let anvil: ChildProcess;
let app: App;
let apiUrl: string;
let registryAddress: Address;
let attestationAddress: Address;
let vendorId: Hex;

const adminAccount = privateKeyToAccount(ADMIN_PK);
const verifierAccount = privateKeyToAccount(VERIFIER_PK);
const vendorAccount = privateKeyToAccount(VENDOR_PK);

const testClient = createTestClient({chain: foundry, mode: "anvil", transport: http(RPC_URL)}).extend(
  publicActions,
);

const vendorWallet = createWalletClient({account: vendorAccount, chain: foundry, transport: http(RPC_URL)});
const verifierWallet = createWalletClient({
  account: verifierAccount,
  chain: foundry,
  transport: http(RPC_URL),
});
const adminWallet = createWalletClient({account: adminAccount, chain: foundry, transport: http(RPC_URL)});

let sdk: ActpClient; // vendor-owner-scoped client

const metadataDoc: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme Cloud",
  description: "API hosting for autonomous agents",
  categories: ["saas", "api-services"],
  paymentMethods: [{rail: "x402"}],
  capabilities: {
    subscriptions: true,
    recurringBilling: true,
    refunds: true,
    apiProvider: true,
    saas: true,
    digitalGoods: true,
    physicalGoods: false,
  },
  countriesServed: ["US"],
  x402: {endpoint: "https://api.acme.example/x402", networks: ["eip155:8453"], assets: ["USDC"]},
};

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await testClient.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not come up");
}

async function sync(): Promise<void> {
  await app.indexer!.runOnce();
}

beforeAll(async () => {
  anvil = spawn(ANVIL, ["--port", String(RPC_PORT), "--silent"], {stdio: "ignore"});
  await waitForRpc();

  // deploy via the production deploy script
  rmSync(path.join(CONTRACTS_DIR, "broadcast/Deploy.s.sol"), {recursive: true, force: true});
  execFileSync(
    FORGE,
    ["script", "script/Deploy.s.sol", "--rpc-url", RPC_URL, "--broadcast", "--private-key", ADMIN_PK],
    {
      cwd: CONTRACTS_DIR,
      env: {...process.env, VERIFIER_ADDRESS: verifierAccount.address},
      stdio: "pipe",
    },
  );
  const broadcast = JSON.parse(
    readFileSync(path.join(CONTRACTS_DIR, "broadcast/Deploy.s.sol/31337/run-latest.json"), "utf8"),
  ) as {transactions: {contractName: string | null; contractAddress: string}[]};
  const proxies = [
    ...new Set(
      broadcast.transactions
        .filter((t) => t.contractName === "ERC1967Proxy")
        .map((t) => t.contractAddress.toLowerCase() as Address),
    ),
  ];
  // classify: the AttestationRegistry proxy answers vendorRegistry() with the other proxy
  let reg: Address | undefined;
  let att: Address | undefined;
  for (const candidate of proxies) {
    try {
      const linked = (await testClient.readContract({
        address: candidate,
        abi: attestationRegistryAbi,
        functionName: "vendorRegistry",
      })) as Address;
      att = candidate;
      reg = linked.toLowerCase() as Address;
    } catch {
      // not the attestation registry
    }
  }
  if (!reg || !att) throw new Error(`could not classify proxies: ${proxies.join(", ")}`);
  registryAddress = reg;
  attestationAddress = att;

  app = await buildApp(
    {
      DATABASE_URL: undefined,
      RPC_URL,
      VENDOR_REGISTRY_ADDRESS: registryAddress,
      ATTESTATION_REGISTRY_ADDRESS: attestationAddress,
      INDEXER_CONFIRMATIONS: 0,
      DEPLOY_BLOCK: 0,
      LOG_LEVEL: "error",
      ADMIN_API_KEY: undefined,
    },
    {withIndexer: true},
  );
  await app.server.listen({port: 0, host: "127.0.0.1"});
  const addr = app.server.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server address");
  apiUrl = `http://127.0.0.1:${addr.port}`;

  sdk = new ActpClient({
    apiUrl,
    rpcUrl: RPC_URL,
    vendorRegistryAddress: registryAddress,
    attestationRegistryAddress: attestationAddress,
    walletClient: vendorWallet,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  anvil?.kill("SIGKILL");
});

describe("V1 — registration and resolution", () => {
  it("registers a vendor onchain through the SDK and resolves it via the API", async () => {
    const result = await sdk.registerVendor({
      primaryDomain: "acme.example",
      wallets: [vendorAccount.address],
      x402Endpoint: "https://api.acme.example/x402",
      metadata: metadataDoc,
    });
    vendorId = result.vendorId;
    expect(vendorId).toMatch(/^0x[0-9a-f]{64}$/i);

    await sync();

    const vendor = await sdk.getVendor(vendorId);
    expect(vendor.primaryDomain).toBe("acme.example");
    expect(vendor.status).toBe("active");
    expect(vendor.owner.toLowerCase()).toBe(vendorAccount.address.toLowerCase());
    expect(vendor.metadataVersion).toBe(1);

    const byWallet = await sdk.resolveWallet(vendorAccount.address);
    expect(byWallet?.vendorId).toBe(vendorId.toLowerCase());
    const byDomain = await sdk.resolveDomain("acme.example");
    expect(byDomain?.vendorId).toBe(vendorId.toLowerCase());
  });

  it("fails closed for unknown counterparties", async () => {
    expect(await sdk.resolveWallet("0x00000000000000000000000000000000000000dE")).toBeNull();
    expect(await sdk.resolveDomain("unknown.example")).toBeNull();
  });

  it("prevents duplicate registration of the same domain", async () => {
    await expect(
      sdk.registerVendor({primaryDomain: "acme.example"}),
    ).rejects.toThrow();
  });
});

describe("V3 — metadata publication and integrity", () => {
  it("publishes the document offchain and verifies against the onchain anchor", async () => {
    await sdk.publishMetadata(vendorId, metadataDoc);
    const verified = await sdk.getVerifiedMetadata(vendorId);
    expect(verified.trusted).toBe(true); // anchored at registration
    expect(verified.anchorSource).toBe("chain");
    expect(verified.document.displayName).toBe("Acme Cloud");
  });

  it("detects tampering: a modified document no longer verifies", async () => {
    const tampered = {...metadataDoc, displayName: "Totally Legit Acme"};
    const {verifyDocumentHash} = await import("@actp/core");
    const onchainHash = (await sdk.getVendor(vendorId)).metadataHash!;
    expect(verifyDocumentHash(tampered, onchainHash)).toBe(false);
  });

  it("stores the document content-addressed and exposes its CID", async () => {
    const published = await sdk.publishMetadata(vendorId, metadataDoc);
    expect(published.cid).toMatch(/^b[a-z2-7]+$/); // CIDv1 base32
    expect(published.uri).toBe(`ipfs://${published.cid}`);

    const verified = await sdk.getVerifiedMetadata(vendorId);
    expect(verified.cid).toBe(published.cid);
  });

  it("trustless retrieval: fetch from the IPFS gateway by onchain CID, verify CID + keccak anchor", async () => {
    const published = await sdk.publishMetadata(vendorId, metadataDoc);
    // vendor anchors the ipfs:// URI (and matching hash) onchain
    await sdk.anchorMetadata(vendorId, metadataDoc, published.uri);
    await sync();

    // gateway = the backend's /ipfs route; the SDK reads the CID from the onchain metadataURI,
    // fetches the bytes, and verifies against BOTH the content address and the onchain hash —
    // it never asks the API for the document.
    const result = await sdk.getMetadataTrustless(vendorId, apiUrl);
    expect(result.cid).toBe(published.cid);
    expect(result.cidValid).toBe(true);
    expect(result.anchorMatch).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.document.displayName).toBe("Acme Cloud");
  });

  it("trustless retrieval rejects a document served under the wrong CID", async () => {
    // fetch the real bytes, then ask the gateway for a different vendor's CID mismatch is
    // covered by verifyCid in getMetadataTrustless; here we assert the gateway itself refuses
    // to serve bytes that don't match the requested CID (defense in depth).
    const res = await app.server.inject({method: "GET", url: `/ipfs/bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr`});
    expect([404, 422]).toContain(res.statusCode);
  });
});

describe("V2 — verification levels", () => {
  it("verifier attestation raises the onchain level", async () => {
    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(0);

    const hash = await verifierWallet.writeContract({
      address: attestationAddress,
      abi: attestationRegistryAbi,
      functionName: "attest",
      args: [
        vendorId,
        3, // LegalEntityVerified
        ("0x" + "12".repeat(32)) as Hex,
        BigInt(Math.floor(Date.now() / 1000) + 180 * 86400),
      ],
      chain: foundry,
    });
    const receipt = await testClient.waitForTransactionReceipt({hash});
    expect(receipt.status).toBe("success");

    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(3);

    await sync();
    const vendor = await sdk.getVendor(vendorId);
    expect(vendor.verificationLevel).toBe(3); // indexer mirrors contract projection

    const attestations = await sdk.getAttestations(vendorId);
    expect(attestations).toHaveLength(1);
    expect(attestations[0]?.active).toBe(true);
  });

  it("vendor-signed metadata reaches level 4 and is bound to the anchored hash", async () => {
    await sdk.vendorSignMetadata(vendorId);
    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(4);

    // republishing different metadata invalidates the signature
    const v2 = {...metadataDoc, description: "now with more compute"};
    await sdk.anchorMetadata(vendorId, v2, "https://acme.example/actp/2");
    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(3);

    // re-sign restores level 4
    await sdk.vendorSignMetadata(vendorId);
    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(4);

    await sync();
    await sdk.publishMetadata(vendorId, v2);
    const verified = await sdk.getVerifiedMetadata(vendorId);
    expect(verified.trusted).toBe(true);
  });
});

describe("V4 — contract intelligence", () => {
  it("extracts terms from a submitted ToS with provenance and confidence", async () => {
    const tos = `Subscriptions automatically renew each month at $49.00. Cancel at any time from your
account settings, at least 10 days before the renewal date. Refunds within 14 days of purchase.
All disputes are resolved through binding arbitration.`;

    const stored = await sdk.submitContractDocument(vendorId, {content: tos});
    const t = stored.terms as never as Record<string, {value: unknown; source: string; confidence: number}>;
    expect(t.autoRenews?.value).toBe(true);
    expect(t.renewalCadence?.value).toBe("monthly");
    expect(t.cancellationDeadlineDays?.value).toBe(10);
    expect(t.arbitrationClause?.source).toBe("deterministic_parse");
    expect(stored.merchantAnchored).toBe(false);

    // owner anchors the exact document -> merchant-anchored terms
    await sdk.anchorContractDocument(vendorId, tos);
    await sync();
    const again = await sdk.submitContractDocument(vendorId, {content: tos});
    expect(again.merchantAnchored).toBe(true);
  });
});

describe("V5 — risk", () => {
  it("scores the verified vendor and explains every point", async () => {
    const score = await sdk.getRisk(vendorId);
    expect(score.rulesetVersion).toBe("1.0.0");
    const rules = score.reasons.map((r) => r.rule);
    expect(rules).not.toContain("verification.unverified"); // level 4 now
    const sum = score.reasons.reduce((a, r) => a + r.weight, 0);
    expect(score.score).toBe(Math.min(100, sum));
  });

  it("guardian suspension fails closed everywhere", async () => {
    const {vendorRegistryAbi} = await import("@actp/core");
    const hash = await adminWallet.writeContract({
      address: registryAddress,
      abi: vendorRegistryAbi,
      functionName: "suspendVendor",
      args: [vendorId, "e2e: abuse reports"],
      chain: foundry,
    });
    await testClient.waitForTransactionReceipt({hash});
    await sync();

    // level collapses to 0 (attestations inactive while suspended)
    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(0);

    const vendor = await sdk.getVendor(vendorId);
    expect(vendor.status).toBe("suspended");
    expect(vendor.verificationLevel).toBe(0);

    const score = await sdk.getRisk(vendorId);
    expect(score.riskLevel).toBe("high");
    expect(score.score).toBeGreaterThanOrEqual(70);
    expect(score.reasons[0]?.rule).toBe("registry.status.suspended");
  });

  it("unsuspension restores verification-derived trust", async () => {
    const {vendorRegistryAbi} = await import("@actp/core");
    const hash = await adminWallet.writeContract({
      address: registryAddress,
      abi: vendorRegistryAbi,
      functionName: "unsuspendVendor",
      args: [vendorId, "e2e: cleared"],
      chain: foundry,
    });
    await testClient.waitForTransactionReceipt({hash});
    await sync();

    expect(await sdk.onchainVerificationLevel(vendorId)).toBe(4);
    const score = await sdk.getRisk(vendorId);
    expect(score.riskLevel).not.toBe("critical");
    expect(score.reasons.map((r) => r.rule)).not.toContain("registry.status.suspended");
  });
});
