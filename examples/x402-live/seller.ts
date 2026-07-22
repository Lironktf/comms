/**
 * A minimal x402-protected seller on Base Sepolia.
 *
 * GET /report is priced at 0.01 USDC. It uses the real @x402/express middleware backed by the
 * keyless community facilitator at https://x402.org/facilitator, which verifies and settles the
 * EIP-3009 USDC authorization on Base Sepolia. This is a genuine x402 merchant — nothing about
 * ACTP is baked in here; ACTP sits on the *client* side (see pay.ts).
 */
import express from "express";
import {paymentMiddleware} from "@x402/express";
import {x402ResourceServer, HTTPFacilitatorClient} from "@x402/core/server";
import {ExactEvmScheme} from "@x402/evm/exact/server";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELLER_PORT ?? 4021);
const NETWORK = "eip155:84532"; // Base Sepolia
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (6 decimals)
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

function walletEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(HERE, ".wallet.testnet.env"), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
const payTo = process.env.SELLER_ADDRESS ?? walletEnv().SELLER_ADDRESS!;

const facilitator = new HTTPFacilitatorClient({url: FACILITATOR});
const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

const routes = {
  "GET /report": {
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      payTo,
      // 0.01 units of the network's default stablecoin (Base Sepolia USDC). Using a plain
      // price lets the scheme attach the token's EIP-712 domain (name/version) so the client
      // can sign the EIP-3009 authorization; an explicit asset+amount omits that domain.
      price: 0.01,
    }],
    description: "Acme Cloud — market intelligence report",
    serviceName: "acme-cloud.example",
  },
};

const app = express();
app.use(paymentMiddleware(routes as never, server));

app.get("/report", (_req, res) => {
  res.json({
    report: "Q3 agentic-commerce market brief",
    figure: "x402 paid calls up 40% QoQ (demo data)",
    servedBy: "acme-cloud.example",
  });
});

app.listen(PORT, () => {
  console.log(`[seller] acme-cloud.example listening on http://127.0.0.1:${PORT}`);
  console.log(`[seller]   GET /report  →  0.01 USDC on ${NETWORK}`);
  console.log(`[seller]   payTo=${payTo}`);
  console.log(`[seller]   facilitator=${FACILITATOR}`);
});
