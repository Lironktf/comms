import {describe, expect, it} from "vitest";
import type {DecisionTokenPayload} from "@actp/core";
import {TokenSigner, newNonce} from "../crypto/tokens.js";
import {authorizeX402Settlement, buildX402Extension, readX402Extension} from "./x402.js";

const WALLET = ("0x" + "bb".repeat(20)) as `0x${string}`;

function tokenFor(signer: TokenSigner, over: Partial<DecisionTokenPayload> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signer.mint({
    decisionId: "dec_1",
    principal: "agent_1",
    rail: "x402",
    payee: {wallet: WALLET},
    maxAmount: "5",
    currency: "USDC",
    vendorId: null,
    issuedAt: now,
    expiresAt: now + 300,
    nonce: newNonce(),
    ...over,
  });
}

describe("x402 settle-time enforcement", () => {
  const {signer} = TokenSigner.fromPemOrEphemeral();

  it("authorizes a settlement that matches the token", () => {
    const token = tokenFor(signer);
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "3000000", asset: {symbol: "USDC", decimals: 6}}, // 3 USDC <= 5
      signer,
    );
    expect(r.authorized).toBe(true);
    expect(r.payload?.decisionId).toBe("dec_1");
  });

  it("refuses when there is no valid token (tampered/forged)", () => {
    const other = TokenSigner.fromPemOrEphemeral().signer;
    const token = tokenFor(other); // signed by a different key
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "1000000", asset: {symbol: "USDC", decimals: 6}},
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/signature|verification/i);
  });

  it("refuses when payTo does not match the authorized payee", () => {
    const token = tokenFor(signer);
    const r = authorizeX402Settlement(
      token,
      {payTo: "0x" + "99".repeat(20), amountAtomic: "1000000", asset: {symbol: "USDC", decimals: 6}},
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/payTo/i);
  });

  it("refuses when the settled amount exceeds the authorized max", () => {
    const token = tokenFor(signer); // max 5 USDC
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "9000000", asset: {symbol: "USDC", decimals: 6}}, // 9 > 5
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/exceeds/i);
  });

  it("refuses on currency mismatch", () => {
    const token = tokenFor(signer, {currency: "USDC"});
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "1000000", asset: {symbol: "EURC", decimals: 6}},
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/currency/i);
  });

  it("refuses a token minted for a different rail", () => {
    const token = tokenFor(signer, {rail: "card"});
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "1000000", asset: {symbol: "USDC", decimals: 6}},
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/rail/i);
  });

  it("refuses an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = tokenFor(signer, {issuedAt: now - 600, expiresAt: now - 1});
    const r = authorizeX402Settlement(
      token,
      {payTo: WALLET, amountAtomic: "1000000", asset: {symbol: "USDC", decimals: 6}},
      signer,
    );
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it("round-trips the vendorId advertisement extension", () => {
    const ext = buildX402Extension("0x" + "11".repeat(32));
    expect(readX402Extension(ext)).toBe("0x" + "11".repeat(32));
    expect(readX402Extension({})).toBeNull();
  });
});
