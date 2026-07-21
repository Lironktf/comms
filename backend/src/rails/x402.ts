import {formatAmount, parseAmount, type DecisionTokenPayload} from "@actp/core";
import {TokenSigner, TokenError} from "../crypto/tokens.js";
import {atomicToDecimal} from "./adapters.js";

/**
 * x402 enforcement (the "advisory → enforced" seam).
 *
 * An x402 facilitator sits between the paying agent and settlement. Before it calls `settle`,
 * it asks ACTP here: is there a valid decision token, and does it actually bind to THIS
 * payment? A denied or tokenless payment simply never settles. One token, verified by
 * signature — the facilitator needs only ACTP's public key, no shared secret.
 */

export interface X402Payment {
  /** the destination wallet from the x402 PaymentRequirements */
  payTo: string;
  /** atomic (base-unit) amount being settled */
  amountAtomic: string;
  asset: {symbol: string; decimals: number};
}

export interface AuthorizationResult {
  authorized: boolean;
  reason: string;
  payload?: DecisionTokenPayload;
}

/**
 * Settle-time guard. Verifies the decision token (signature + expiry) and that it is bound to
 * this exact payment: same rail, same payee wallet, same currency, and the settled amount is
 * within the authorized maximum.
 */
export function authorizeX402Settlement(
  token: string,
  payment: X402Payment,
  signer: TokenSigner,
  now = new Date(),
): AuthorizationResult {
  let payload: DecisionTokenPayload;
  try {
    payload = signer.verify(token, now);
  } catch (e) {
    return {authorized: false, reason: e instanceof TokenError ? e.message : "token verification failed"};
  }

  if (payload.rail !== "x402") {
    return {authorized: false, reason: `token is for rail '${payload.rail}', not x402`};
  }

  const tokenWallet = payload.payee.wallet?.toLowerCase();
  if (!tokenWallet || tokenWallet !== payment.payTo.toLowerCase()) {
    return {authorized: false, reason: "payTo does not match the authorized payee wallet"};
  }

  if (payload.currency.toUpperCase() !== payment.asset.symbol.toUpperCase()) {
    return {authorized: false, reason: `currency mismatch: token ${payload.currency}, payment ${payment.asset.symbol}`};
  }

  const settled = parseAmount(atomicToDecimal(payment.amountAtomic, payment.asset.decimals));
  const authorizedMax = parseAmount(payload.maxAmount);
  if (settled > authorizedMax) {
    return {
      authorized: false,
      reason: `settlement ${formatAmount(settled)} exceeds authorized max ${formatAmount(authorizedMax)}`,
    };
  }

  return {authorized: true, reason: "authorized", payload};
}

/**
 * The `extensions` object a merchant adds to its x402 `PaymentRequired` response to advertise
 * its ACTP vendor id. The agent then verifies onchain that the vendor actually lists this
 * payTo wallet — the binding is checked, never trusted.
 */
export function buildX402Extension(vendorId: string): Record<string, unknown> {
  return {
    "actp": {
      info: {vendorId, verify: "confirm this vendorId lists the payTo wallet in the ACTP registry"},
      schema: {type: "object", properties: {vendorId: {type: "string"}}},
    },
  };
}

/** Extract a claimed ACTP vendor id from an x402 PaymentRequired.extensions object, if present. */
export function readX402Extension(extensions: unknown): string | null {
  const actp = (extensions as {actp?: {info?: {vendorId?: string}}} | null | undefined)?.actp;
  return actp?.info?.vendorId ?? null;
}
