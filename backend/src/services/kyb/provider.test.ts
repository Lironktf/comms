import {describe, expect, it} from "vitest";
import {StubKybProvider} from "./provider.js";

describe("StubKybProvider", () => {
  const p = new StubKybProvider();

  it("passes on a well-formed LEI + legal name", async () => {
    const r = await p.verify({vendorId: "0xabc", legalName: "Acme Inc", registrationId: "5493001KJTIIGC8Y1R12"});
    expect(r.passed).toBe(true);
    expect(r.detail.method).toBe("lei");
    expect(r.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("passes on jurisdiction + registration number", async () => {
    const r = await p.verify({vendorId: "0xabc", legalName: "Acme LLC", jurisdiction: "US-DE", registrationId: "1234567"});
    expect(r.passed).toBe(true);
    expect(r.detail.method).toBe("jurisdiction_registry");
  });

  it("fails without a legal entity identifier", async () => {
    const r = await p.verify({vendorId: "0xabc", legalName: "Acme"});
    expect(r.passed).toBe(false);
  });

  it("is deterministic (same input -> same evidence hash, modulo the date)", async () => {
    const input = {vendorId: "0xabc", legalName: "Acme Inc", registrationId: "5493001KJTIIGC8Y1R12"};
    const a = await p.verify(input);
    const b = await p.verify(input);
    expect(a.evidenceHash).toBe(b.evidenceHash);
  });
});
