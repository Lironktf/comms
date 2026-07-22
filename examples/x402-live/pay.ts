/**
 * The ACTP-gated x402 payer.
 *
 * This is the whole point of the demo. A normal x402 client would: hit the endpoint → get a 402
 * → sign an EIP-3009 USDC authorization → resend and pay. Here we insert ACTP into the
 * `onBeforePaymentCreation` hook — the exact client-side seam the x402 spec leaves open ("budget
 * management" and "spending controls" are explicitly out of scope). Before ANY signature is
 * produced, we ask the live ACTP decision engine: should this agent pay THIS merchant, THIS
 * amount, right now? On anything other than ALLOW we abort — no signature, no settlement.
 *
 * Usage:  tsx pay.ts             # pay the seeded, verified merchant  → ALLOW
 *         tsx pay.ts --rogue     # redirect payTo to an unknown wallet → DENY (before signing)
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";
import {privateKeyToAccount} from "viem/accounts";
import {wrapFetchWithPayment, x402Client, decodePaymentResponseHeader} from "@x402/fetch";
import {ExactEvmScheme} from "@x402/evm";

const HERE = dirname(fileURLToPath(import.meta.url));
const NETWORK = "eip155:84532";
const ROGUE = process.argv.includes("--rogue");
const ROGUE_WALLET = "0x000000000000000000000000000000000000dEaD";

function envFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const wallet = envFile(join(HERE, ".wallet.testnet.env"));
const state = JSON.parse(readFileSync(join(HERE, ".demo-state.json"), "utf8")) as {
  apiUrl: string; agentId: string; vendorId: string; sellerAddress: string;
};
const SELLER_URL = process.env.SELLER_URL ?? "http://127.0.0.1:4021/report";
const account = privateKeyToAccount(wallet.DEMO_PRIVATE_KEY as `0x${string}`);

let lastDecision: {outcome: string; token: string | null; decisionId: string} | null = null;

/** Seam A: the pre-payment decision. Calls the live ACTP engine and aborts on non-allow. */
async function actpCheck(selected: {payTo: string; amount: string; asset: string; network: string}, resourceUrl: string) {
  // In --rogue mode we pretend the 402 pointed us at an unknown wallet (funds-redirect attempt).
  const payTo = ROGUE ? ROGUE_WALLET : selected.payTo;

  const body = {
    requestId: `req_${randomUUID()}`,
    principal: {agentId: state.agentId},
    payload: {
      network: selected.network,
      payTo,
      asset: {symbol: "USDC", decimals: 6, address: selected.asset},
      amountAtomic: selected.amount,
      resource: resourceUrl,
      category: "api-services",
    },
  };
  const res = await fetch(`${state.apiUrl}/v1/decisions/rail/x402`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const {decision} = (await res.json()) as {decision: {outcome: string; token: string | null; decisionId: string; vendorId: string | null; verificationLevel: number | null; riskLevel: string | null; reasons: {rule: string; effect: string}[]}};
  lastDecision = decision;

  const usd = (Number(selected.amount) / 1e6).toFixed(2);
  console.log(`\n── ACTP pre-payment check ${"─".repeat(40)}`);
  console.log(`   agent      ${state.agentId}`);
  console.log(`   pay        ${usd} USDC  →  ${payTo}`);
  console.log(`   merchant   ${decision.vendorId ? `verified vendor ${decision.vendorId.slice(0, 12)}… (level ${decision.verificationLevel}, risk ${decision.riskLevel})` : "UNKNOWN — no registered vendor claims this wallet"}`);
  console.log(`   reasons`);
  for (const r of decision.reasons) console.log(`     • [${r.effect}] ${r.rule}`);
  console.log(`   ➜ OUTCOME: ${decision.outcome.toUpperCase()}`);
  console.log("─".repeat(66));

  if (decision.outcome !== "allow") {
    return {abort: true as const, reason: `ACTP ${decision.outcome} for ${payTo}`};
  }
  return; // allow → let x402 proceed to sign + pay
}

async function main() {
  console.log(`x402 + ACTP live demo on Base Sepolia (${NETWORK})`);
  console.log(`payer wallet: ${account.address}${ROGUE ? "   [--rogue: redirecting payTo to an unknown wallet]" : ""}`);

  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(account))
    .onBeforePaymentCreation(async (ctx) => {
      const s = ctx.selectedRequirements;
      return actpCheck(
        {payTo: s.payTo, amount: s.amount, asset: s.asset, network: s.network},
        ctx.paymentRequired.resource?.url ?? SELLER_URL,
      );
    });

  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  try {
    const res = await fetchWithPay(SELLER_URL);
    const payload = await res.json();
    console.log(`\n✅ PAID & FULFILLED — seller returned:`);
    console.log(JSON.stringify(payload, null, 2));

    // decode the on-chain settlement (tx hash) from the response header
    try {
      const settle = decodePaymentResponseHeader(res.headers as never);
      if (settle) console.log(`\n   settlement:`, JSON.stringify(settle));
    } catch { /* header shape varies; non-fatal */ }

    // Seam B: show the facilitator-side guard would also accept this exact settlement.
    if (lastDecision?.token) {
      const guard = await fetch(`${state.apiUrl}/v1/x402/authorize-settlement`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          token: lastDecision.token,
          payment: {payTo: state.sellerAddress, amountAtomic: "10000", asset: {symbol: "USDC", decimals: 6}},
        }),
      });
      console.log(`   settle-time guard (Seam B):`, JSON.stringify(await guard.json()));
    }
  } catch (e) {
    console.log(`\n🛑 PAYMENT BLOCKED — no signature was ever produced.`);
    console.log(`   ${(e as Error).message}`);
    process.exitCode = ROGUE ? 0 : 1; // in --rogue a block is the expected, successful outcome
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
