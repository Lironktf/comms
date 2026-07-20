import {describe, expect, it} from "vitest";
import type {DecisionTokenPayload} from "@actp/core";
import {TokenSigner, TokenError, newNonce} from "./tokens.js";

function payload(over: Partial<DecisionTokenPayload> = {}): DecisionTokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    decisionId: "dec_1",
    principal: "agent_1",
    rail: "x402",
    payee: {wallet: "0x" + "ab".repeat(20) as `0x${string}`},
    maxAmount: "50",
    currency: "USDC",
    vendorId: null,
    issuedAt: now,
    expiresAt: now + 300,
    nonce: newNonce(),
    ...over,
  };
}

describe("decision tokens", () => {
  it("mints and verifies a token round-trip", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    const p = payload();
    const token = signer.mint(p);
    expect(token.split(".")).toHaveLength(3);
    expect(signer.verify(token)).toEqual(p);
  });

  it("rejects a tampered payload", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    const token = signer.mint(payload({maxAmount: "50"}));
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify(payload({maxAmount: "5000"}))).toString("base64url");
    expect(() => signer.verify(`${h}.${forged}.${s}`)).toThrow(TokenError);
  });

  it("rejects a token signed by a different key", () => {
    const a = TokenSigner.fromPemOrEphemeral().signer;
    const b = TokenSigner.fromPemOrEphemeral().signer;
    const token = a.mint(payload());
    expect(() => b.verify(token)).toThrow(TokenError);
  });

  it("rejects an expired token", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    const now = Math.floor(Date.now() / 1000);
    const token = signer.mint(payload({issuedAt: now - 600, expiresAt: now - 1}));
    expect(() => signer.verify(token)).toThrow(/expired/);
  });

  it("a standalone verifier (public key only) verifies a signer's tokens", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    const verifier = TokenSigner.verifierFromPem(signer.publicKeyPem());
    const token = signer.mint(payload());
    expect(verifier.verify(token).decisionId).toBe("dec_1");
  });

  it("loads a persisted PEM private key deterministically", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    const pem = (signer as unknown as {privateKey: {export: (o: object) => Buffer}}).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString();
    const {signer: reloaded, ephemeral} = TokenSigner.fromPemOrEphemeral(pem);
    expect(ephemeral).toBe(false);
    expect(reloaded.publicKeyPem()).toBe(signer.publicKeyPem());
  });

  it("rejects malformed tokens", () => {
    const {signer} = TokenSigner.fromPemOrEphemeral();
    expect(() => signer.verify("not.a.token")).toThrow(TokenError);
    expect(() => signer.verify("only-one-part")).toThrow(TokenError);
  });
});
