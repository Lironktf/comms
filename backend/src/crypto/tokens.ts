import {createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject} from "node:crypto";
import type {DecisionTokenPayload} from "@actp/core";

/**
 * Signed decision tokens (ACTP V12 enforcement primitive).
 *
 * A decision token is what turns a policy verdict from advice into enforcement: on ALLOW
 * (or after human approval) the decision service mints a short-lived Ed25519-signed token,
 * and every rail's enforcement point — an x402 facilitator, a card issuer's JIT hook, an A2A
 * endpoint — verifies it before settling. One token format across all rails; the signature
 * chains the settlement back to a specific, auditable policy decision.
 *
 * Compact JWS-style encoding: base64url(header).base64url(payload).base64url(sig).
 */

interface Header {
  alg: "EdDSA";
  typ: "actp-decision-v1";
}

const HEADER: Header = {alg: "EdDSA", typ: "actp-decision-v1"};

export class TokenSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly publicKey: KeyObject,
  ) {}

  /** Load an Ed25519 private key from PEM, or generate an ephemeral keypair (dev only). */
  static fromPemOrEphemeral(privateKeyPem?: string): {signer: TokenSigner; ephemeral: boolean} {
    if (privateKeyPem && privateKeyPem.trim().length > 0) {
      const priv = createPrivateKey(privateKeyPem);
      const pub = createPublicKey(priv);
      return {signer: new TokenSigner(priv, pub), ephemeral: false};
    }
    const {privateKey, publicKey} = generateKeyPairSync("ed25519");
    return {signer: new TokenSigner(privateKey, publicKey), ephemeral: true};
  }

  /** Verifier-only signer built from a public key (for enforcement points). */
  static verifierFromPem(publicKeyPem: string): TokenVerifier {
    return new TokenVerifier(createPublicKey(publicKeyPem));
  }

  publicKeyPem(): string {
    return this.publicKey.export({type: "spki", format: "pem"}).toString();
  }

  mint(payload: DecisionTokenPayload): string {
    const signingInput = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(payload))}`;
    const sig = sign(null, Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${b64urlBuf(sig)}`;
  }

  verify(token: string, now = new Date()): DecisionTokenPayload {
    return verifyToken(token, this.publicKey, now);
  }
}

export class TokenVerifier {
  constructor(private readonly publicKey: KeyObject) {}
  verify(token: string, now = new Date()): DecisionTokenPayload {
    return verifyToken(token, this.publicKey, now);
  }
  publicKeyPem(): string {
    return this.publicKey.export({type: "spki", format: "pem"}).toString();
  }
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

function verifyToken(token: string, publicKey: KeyObject, now: Date): DecisionTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [h, p, s] = parts as [string, string, string];

  let header: Header;
  try {
    header = JSON.parse(fromB64url(h));
  } catch {
    throw new TokenError("bad header");
  }
  if (header.alg !== "EdDSA" || header.typ !== HEADER.typ) throw new TokenError("unsupported token type");

  const ok = verify(null, Buffer.from(`${h}.${p}`), publicKey, fromB64urlBuf(s));
  if (!ok) throw new TokenError("invalid signature");

  let payload: DecisionTokenPayload;
  try {
    payload = JSON.parse(fromB64url(p));
  } catch {
    throw new TokenError("bad payload");
  }
  if (Math.floor(now.getTime() / 1000) >= payload.expiresAt) throw new TokenError("token expired");
  return payload;
}

function b64url(s: string): string {
  return b64urlBuf(Buffer.from(s));
}
function b64urlBuf(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): string {
  return fromB64urlBuf(s).toString("utf8");
}
function fromB64urlBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
