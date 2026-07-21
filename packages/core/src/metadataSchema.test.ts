import {describe, expect, it} from "vitest";
import {validateMerchantMetadata, MAX_METADATA_BYTES, type MerchantMetadata} from "./metadataSchema.js";

const valid: MerchantMetadata = {
  schema: "actp.metadata.v1",
  primaryDomain: "acme.example",
  displayName: "Acme Cloud",
  categories: ["software", "api-services"],
  paymentMethods: [{rail: "x402"}, {rail: "card"}],
  capabilities: {
    subscriptions: true,
    recurringBilling: true,
    refunds: true,
    apiProvider: true,
    saas: true,
    digitalGoods: true,
    physicalGoods: false,
  },
  countriesServed: ["US", "DE"],
  x402: {endpoint: "https://api.acme.example/x402", networks: ["eip155:8453"], assets: ["USDC"]},
  contact: {email: "ops@acme.example", url: "https://acme.example"},
};

describe("merchant metadata schema", () => {
  it("accepts a well-formed document", () => {
    expect(() => validateMerchantMetadata(valid)).not.toThrow();
  });

  it("rejects an unknown top-level field (strict)", () => {
    expect(() => validateMerchantMetadata({...valid, injected: "evil"})).toThrow();
  });

  it("rejects the wrong schema literal", () => {
    expect(() => validateMerchantMetadata({...valid, schema: "actp.metadata.v2"})).toThrow();
  });

  it("rejects non-normalized or malformed domains", () => {
    for (const d of ["ACME.example", "no-dot", "bad_underscore.example", "-lead.example", ""]) {
      expect(() => validateMerchantMetadata({...valid, primaryDomain: d}), d).toThrow();
    }
  });

  it("enforces category rules", () => {
    expect(() => validateMerchantMetadata({...valid, categories: []})).toThrow(); // min 1
    expect(() => validateMerchantMetadata({...valid, categories: ["Bad Caps"]})).toThrow(); // kebab only
    expect(() => validateMerchantMetadata({...valid, categories: Array(21).fill("x")})).toThrow(); // max 20
  });

  it("requires all capability booleans", () => {
    const {capabilities, ...rest} = valid;
    expect(() => validateMerchantMetadata(rest)).toThrow();
    const partial = {...capabilities} as Record<string, unknown>;
    delete partial.refunds;
    expect(() => validateMerchantMetadata({...valid, capabilities: partial})).toThrow();
  });

  it("validates payment rails against the enum", () => {
    expect(() => validateMerchantMetadata({...valid, paymentMethods: [{rail: "wire-transfer"}]})).toThrow();
    expect(() => validateMerchantMetadata({...valid, paymentMethods: []})).toThrow();
  });

  it("validates country codes", () => {
    expect(() => validateMerchantMetadata({...valid, countriesServed: ["usa"]})).toThrow();
    expect(() => validateMerchantMetadata({...valid, countriesServed: ["US", "de"]})).toThrow();
  });

  it("validates the x402 block (CAIP-2 networks, URL endpoint)", () => {
    expect(() => validateMerchantMetadata({...valid, x402: {endpoint: "not-a-url", networks: ["eip155:8453"], assets: ["USDC"]}})).toThrow();
    expect(() => validateMerchantMetadata({...valid, x402: {endpoint: "https://x", networks: ["8453"], assets: ["USDC"]}})).toThrow();
    expect(() => validateMerchantMetadata({...valid, x402: {endpoint: "https://x", networks: ["eip155:8453"], assets: []}})).toThrow();
  });

  it("rejects an oversized document", () => {
    const huge = {...valid, description: "x".repeat(MAX_METADATA_BYTES)};
    expect(() => validateMerchantMetadata(huge)).toThrow(/exceeds/);
  });

  it("rejects a bad contact email / url", () => {
    expect(() => validateMerchantMetadata({...valid, contact: {email: "not-an-email"}})).toThrow();
    expect(() => validateMerchantMetadata({...valid, contact: {url: "nope not a url"}})).toThrow();
  });
});
