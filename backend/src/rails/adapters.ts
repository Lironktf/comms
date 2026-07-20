import type {PrincipalRef, PurchaseRequest, Rail} from "@actp/core";
import type {Hex} from "viem";

/**
 * ACTP cross-rail adapters.
 *
 * Every payment rail describes a purchase differently — x402 speaks atomic token units and
 * CAIP-2 networks, card auth speaks MCC + acquirer merchant ids, ACP/AP2 speak carts and
 * mandates. Each adapter normalizes its native shape into ONE `PurchaseRequest`, so the
 * decision engine, policy, and budgets never learn about rails. Adding a rail is adding an
 * adapter — nothing downstream changes. This is what "define policy once, enforce everywhere"
 * actually requires in code.
 */

export interface AdapterMeta {
  requestId: string;
  principal: PrincipalRef;
}

// --- x402 -------------------------------------------------------------------

export interface X402PaymentRequirements {
  /** CAIP-2 network id, e.g. "eip155:8453". */
  network: string;
  payTo: Hex;
  asset: {symbol: string; decimals: number; address?: Hex};
  /** atomic (integer) amount in the asset's base units. */
  amountAtomic: string;
  /** the paid resource URL, if any. */
  resource?: string;
  category?: string;
}

export function normalizeX402(req: X402PaymentRequirements, meta: AdapterMeta): PurchaseRequest {
  return {
    requestId: meta.requestId,
    principal: meta.principal,
    rail: "x402",
    amount: {value: atomicToDecimal(req.amountAtomic, req.asset.decimals), currency: req.asset.symbol.toUpperCase()},
    payee: {
      wallet: req.payTo,
      ...(req.resource ? {endpoint: req.resource, domain: hostOf(req.resource)} : {}),
    },
    ...(req.category ? {category: req.category} : {}),
    railData: req,
  };
}

// --- ACP (Stripe/OpenAI Agentic Commerce Protocol) --------------------------

export interface AcpDelegatePayment {
  merchant: {id?: string; name?: string; domain?: string};
  amount: {value: string; currency: string};
  subscription?: boolean;
  category?: string;
}

export function normalizeAcp(req: AcpDelegatePayment, meta: AdapterMeta): PurchaseRequest {
  return {
    requestId: meta.requestId,
    principal: meta.principal,
    rail: "acp",
    amount: {value: req.amount.value, currency: req.amount.currency.toUpperCase()},
    payee: {
      ...(req.merchant.id ? {merchantId: req.merchant.id} : {}),
      ...(req.merchant.domain ? {domain: req.merchant.domain.toLowerCase()} : {}),
    },
    ...(req.category ? {category: req.category} : {}),
    ...(req.subscription !== undefined ? {subscription: req.subscription} : {}),
    railData: req,
  };
}

// --- card authorization -----------------------------------------------------

export interface CardAuthorization {
  merchantName: string;
  mcc: string; // 4-digit merchant category code
  acquirerMerchantId?: string;
  merchantDomain?: string;
  amount: {value: string; currency: string};
  recurring?: boolean;
}

export function normalizeCard(req: CardAuthorization, meta: AdapterMeta): PurchaseRequest {
  return {
    requestId: meta.requestId,
    principal: meta.principal,
    rail: "card",
    amount: {value: req.amount.value, currency: req.amount.currency.toUpperCase()},
    payee: {
      ...(req.acquirerMerchantId ? {merchantId: req.acquirerMerchantId} : {}),
      ...(req.merchantDomain ? {domain: req.merchantDomain.toLowerCase()} : {}),
    },
    category: mccToCategory(req.mcc),
    ...(req.recurring !== undefined ? {subscription: req.recurring} : {}),
    metadata: {mcc: req.mcc, merchantName: req.merchantName},
    railData: req,
  };
}

// --- AP2 (Google Agent Payments Protocol) -----------------------------------

export interface Ap2Mandate {
  cart: {
    merchant: {id?: string; name?: string; domain?: string};
    total: {value: string; currency: string};
  };
  category?: string;
  subscription?: boolean;
}

export function normalizeAp2(req: Ap2Mandate, meta: AdapterMeta): PurchaseRequest {
  return {
    requestId: meta.requestId,
    principal: meta.principal,
    rail: "ap2",
    amount: {value: req.cart.total.value, currency: req.cart.total.currency.toUpperCase()},
    payee: {
      ...(req.cart.merchant.id ? {merchantId: req.cart.merchant.id} : {}),
      ...(req.cart.merchant.domain ? {domain: req.cart.merchant.domain.toLowerCase()} : {}),
    },
    ...(req.category ? {category: req.category} : {}),
    ...(req.subscription !== undefined ? {subscription: req.subscription} : {}),
    railData: req,
  };
}

// --- helpers ----------------------------------------------------------------

export const ADAPTERS: Record<string, (req: never, meta: AdapterMeta) => PurchaseRequest> = {
  x402: normalizeX402 as never,
  acp: normalizeAcp as never,
  card: normalizeCard as never,
  ap2: normalizeAp2 as never,
};

/** Insert a decimal point into an atomic integer amount. */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw new Error(`invalid atomic amount: ${atomic}`);
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Minimal MCC → ACTP category map. Real deployments load the full ISO 18245 table; coarse
 *  categories are enough for policy rules like `category in ["software","api"]`. */
const MCC_CATEGORIES: Record<string, string> = {
  "5734": "software",
  "5817": "software", // digital goods / apps
  "5818": "digital-goods",
  "7372": "software", // computer programming / SaaS
  "4816": "api-services", // computer network / information services
  "5968": "subscription", // continuity/subscription merchants
  "7995": "gambling",
  "5967": "adult",
  "6051": "crypto", // quasi-cash / crypto
  "4900": "utilities",
  "5411": "physical-goods", // grocery
  "5999": "physical-goods", // misc retail
};

export function mccToCategory(mcc: string): string {
  return MCC_CATEGORIES[mcc] ?? "uncategorized";
}

export function railFromString(s: string): Rail {
  const valid: Rail[] = ["x402", "acp", "card", "ap2", "sepa", "ach", "other"];
  return valid.includes(s as Rail) ? (s as Rail) : "other";
}
