import type {Hex} from "viem";

/**
 * The cross-rail decision layer (ACTP V6–V13).
 *
 * The whole point: define policy once, enforce it across every payment rail. Each rail's
 * native request is normalized by an adapter into ONE `PurchaseRequest`, evaluated by ONE
 * policy engine against ONE budget/permission model, and — on allow — enforced by ONE signed
 * decision-token format that any rail's enforcement point (x402 facilitator, card issuer,
 * A2A endpoint) can verify. No rail is privileged.
 */

export type Rail = "x402" | "acp" | "card" | "ap2" | "sepa" | "ach" | "other";
export const RAILS: Rail[] = ["x402", "acp", "card", "ap2", "sepa", "ach", "other"];

/** Reference to who is spending. Resolves to an org → department → agent chain. */
export interface PrincipalRef {
  agentId: string;
}

export interface Money {
  /** Decimal string, e.g. "29.99". */
  value: string;
  /** ISO-4217 code or asset symbol (USD, EUR, USDC, EURC, …). */
  currency: string;
}

/** Rail-agnostic purchase request — the single shape every adapter produces. */
export interface PurchaseRequest {
  /** Client-supplied idempotency key. */
  requestId: string;
  principal: PrincipalRef;
  rail: Rail;
  amount: Money;
  /** Counterparty identifiers; adapters populate whatever the rail provides. */
  payee: {
    wallet?: Hex;
    domain?: string;
    endpoint?: string;
    /** Rail-native merchant id (ACP/card). */
    merchantId?: string;
    /** Pre-resolved ACTP vendor id, if the caller already knows it. */
    vendorId?: Hex;
  };
  category?: string;
  /** True if this is a recurring/subscription charge. */
  subscription?: boolean;
  metadata?: Record<string, unknown>;
  /** Original rail payload, preserved for the audit trail. */
  railData?: unknown;
}

/**
 * Constraints a parent principal imposes on a child (org → department → agent). Delegation
 * can only NARROW: the effective authority of an agent is the intersection of every
 * constraint along its chain. Amounts are in the org's normalized currency.
 */
export interface DelegationConstraints {
  maxAmount?: string;
  rails?: Rail[];
  categories?: string[];
  allowedVendors?: Hex[];
  deniedVendors?: Hex[];
  expiresAt?: string;
}

export type DecisionOutcome = "allow" | "deny" | "require_approval";

export interface DecisionReason {
  /** Which layer produced this reason: policy statement id, "budget", "risk", "principal". */
  source: "policy" | "budget" | "risk" | "principal" | "vendor";
  rule: string;
  effect: DecisionOutcome | "signal";
  evidence: Record<string, unknown>;
}

export interface Decision {
  decisionId: string;
  requestId: string;
  principal: PrincipalRef;
  rail: Rail;
  amount: Money;
  outcome: DecisionOutcome;
  reasons: DecisionReason[];
  vendorId: Hex | null;
  verificationLevel: number | null;
  riskLevel: string | null;
  riskScore: number | null;
  policyVersion: string;
  /** keccak256 of the canonicalized decision context — makes the decision reproducible. */
  contextHash: Hex;
  /** Budget holds placed on allow (released if never settled). */
  holdIds: string[];
  /** Present when outcome === "require_approval". */
  approvalId: string | null;
  /** Signed enforcement token; present only on allow (or after approval). */
  token: string | null;
  evaluatedAt: string;
}

/**
 * Payload inside a signed decision token. An enforcement point verifies the signature, then
 * checks the actual settlement stays within `maxAmount`/`currency`/`rail`/`payee` and before
 * `expiresAt`. Rail-agnostic by construction.
 */
export interface DecisionTokenPayload {
  decisionId: string;
  principal: string;
  rail: Rail;
  payee: PurchaseRequest["payee"];
  maxAmount: string;
  currency: string;
  vendorId: Hex | null;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

// ---------------------------------------------------------------------------
// V13 — receipts / audit
// ---------------------------------------------------------------------------

export type ReceiptEvent = "decision" | "approval" | "settlement" | "dispute";

export interface Receipt {
  receiptId: string;
  /** Per-org hash chain sequence number (1-based). */
  seq: number;
  orgId: string;
  event: ReceiptEvent;
  /** keccak256 over prevHash ‖ canonical(payload) ‖ seq. */
  hash: Hex;
  prevHash: Hex;
  payload: Record<string, unknown>;
  createdAt: string;
}
