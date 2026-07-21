import {generateKeyPairSync, sign} from "node:crypto";
import {describe, expect, it} from "vitest";
import {canonicalize, type AgentAuth, type SignedMandate} from "@actp/core";
import {verifyAgentAuth, verifyMandate} from "./agentAuth.js";

function keypair() {
  const {publicKey, privateKey} = generateKeyPairSync("ed25519");
  return {
    pem: publicKey.export({type: "spki", format: "pem"}).toString(),
    signMsg: (m: string) => sign(null, Buffer.from(m), privateKey).toString("base64url"),
  };
}

describe("agent identity (Web-Bot-Auth-style)", () => {
  it("verifies a correctly signed agent assertion", () => {
    const kp = keypair();
    const auth: AgentAuth = {agentId: "agent_1", publicKeyPem: kp.pem, nonce: "abc123", signature: kp.signMsg("agent_1.abc123")};
    expect(verifyAgentAuth(auth)).toBe(true);
  });

  it("rejects a wrong signature / tampered nonce", () => {
    const kp = keypair();
    const auth: AgentAuth = {agentId: "agent_1", publicKeyPem: kp.pem, nonce: "abc123", signature: kp.signMsg("agent_1.DIFFERENT")};
    expect(verifyAgentAuth(auth)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const kp = keypair();
    const other = keypair();
    const auth: AgentAuth = {agentId: "agent_1", publicKeyPem: kp.pem, nonce: "n", signature: other.signMsg("agent_1.n")};
    expect(verifyAgentAuth(auth)).toBe(false);
  });
});

describe("AP2-style signed mandate", () => {
  it("verifies a valid mandate and surfaces constraints", () => {
    const kp = keypair();
    const fields = {maxAmount: "250", currency: "USD", merchant: "acme.example", nonce: "m1"};
    const m: SignedMandate = {
      publicKeyPem: kp.pem,
      ...fields,
      signature: kp.signMsg(canonicalize({maxAmount: "250", currency: "USD", merchant: "acme.example", nonce: "m1"})),
    };
    const r = verifyMandate(m);
    expect(r.valid).toBe(true);
    expect(r.constraints).toEqual({maxAmount: "250", currency: "USD", merchant: "acme.example"});
  });

  it("rejects a tampered mandate (amount changed after signing)", () => {
    const kp = keypair();
    const m: SignedMandate = {
      publicKeyPem: kp.pem,
      maxAmount: "9999", // changed
      currency: "USD",
      merchant: "acme.example",
      nonce: "m1",
      signature: kp.signMsg(canonicalize({maxAmount: "250", currency: "USD", merchant: "acme.example", nonce: "m1"})),
    };
    expect(verifyMandate(m).valid).toBe(false);
  });
});
