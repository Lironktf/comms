import {createPublicKey, verify} from "node:crypto";
import {canonicalize, type AgentAuth, type SignedMandate} from "@actp/core";

/**
 * Verification for the two "who authorized this" inputs to a decision:
 *  - agent identity (Web-Bot-Auth-style): the calling agent signs a nonce with its key.
 *  - user mandate (AP2-style): the user signs a spend envelope.
 *
 * Both are Ed25519 signatures over a canonical message. This is the primitive; production
 * would resolve the public key from a well-known JWKS and pin it, and (for AP2) accept the
 * W3C-VC encodings — noted as follow-ups. The point today is that these become first-class
 * policy attributes (`agent.verified`, `mandate.present`) an org can require.
 */

function verifyEd25519(publicKeyPem: string, message: string, signatureB64Url: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureB64Url.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return verify(null, Buffer.from(message), key, sig);
  } catch {
    return false;
  }
}

/** True iff the agent's signature over `${agentId}.${nonce}` verifies against its public key. */
export function verifyAgentAuth(auth: AgentAuth): boolean {
  return verifyEd25519(auth.publicKeyPem, `${auth.agentId}.${auth.nonce}`, auth.signature);
}

export interface MandateVerification {
  valid: boolean;
  constraints: {maxAmount?: string; currency?: string; merchant?: string};
}

/** Verify a signed user mandate and surface its constraints. */
export function verifyMandate(m: SignedMandate): MandateVerification {
  const message = canonicalize({
    maxAmount: m.maxAmount ?? null,
    currency: m.currency ?? null,
    merchant: m.merchant ?? null,
    nonce: m.nonce,
  });
  const valid = verifyEd25519(m.publicKeyPem, message, m.signature);
  return {
    valid,
    constraints: {
      ...(m.maxAmount !== undefined ? {maxAmount: m.maxAmount} : {}),
      ...(m.currency !== undefined ? {currency: m.currency} : {}),
      ...(m.merchant !== undefined ? {merchant: m.merchant} : {}),
    },
  };
}
