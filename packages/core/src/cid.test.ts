import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {CID} from "multiformats/cid";
import {computeCid, verifyCid, isValidCid, parseIpfsUri, toIpfsUri} from "./cid.js";
import {canonicalBytes} from "./canonical.js";

describe("computeCid", () => {
  it("produces a valid CIDv1 raw/sha2-256 identifier", async () => {
    const cid = await computeCid(new TextEncoder().encode("hello world"));
    expect(cid.startsWith("b")).toBe(true); // base32 multibase prefix (CIDv1)
    const parsed = CID.parse(cid);
    expect(parsed.version).toBe(1);
    expect(parsed.code).toBe(0x55); // raw codec
    expect(parsed.multihash.code).toBe(0x12); // sha2-256
  });

  it("is genuinely content-addressed: the multihash digest equals SHA-256 of the bytes", async () => {
    const bytes = new TextEncoder().encode("the quick brown fox");
    const cid = await computeCid(bytes);
    const digest = Buffer.from(CID.parse(cid).multihash.digest);
    const independent = createHash("sha256").update(Buffer.from(bytes)).digest();
    expect(digest.equals(independent)).toBe(true);
  });

  it("is deterministic", async () => {
    const bytes = new TextEncoder().encode("determinism");
    expect(await computeCid(bytes)).toBe(await computeCid(bytes));
  });

  it("differs for any change in content", async () => {
    const a = await computeCid(new TextEncoder().encode("acme cloud v1"));
    const b = await computeCid(new TextEncoder().encode("acme cloud v2"));
    expect(a).not.toBe(b);
  });
});

describe("verifyCid", () => {
  it("accepts matching bytes and rejects tampered bytes", async () => {
    const bytes = canonicalBytes({schema: "actp.metadata.v1", displayName: "Acme"});
    const cid = await computeCid(bytes);
    expect(await verifyCid(bytes, cid)).toBe(true);

    const tampered = canonicalBytes({schema: "actp.metadata.v1", displayName: "Evil"});
    expect(await verifyCid(tampered, cid)).toBe(false);
  });

  it("rejects a malformed cid without throwing", async () => {
    expect(await verifyCid(new Uint8Array([1, 2, 3]), "not-a-cid")).toBe(false);
  });
});

describe("cid helpers", () => {
  it("validates and round-trips ipfs uris", async () => {
    const cid = await computeCid(new TextEncoder().encode("x"));
    expect(isValidCid(cid)).toBe(true);
    expect(isValidCid("nope")).toBe(false);
    expect(toIpfsUri(cid)).toBe(`ipfs://${cid}`);
    expect(parseIpfsUri(`ipfs://${cid}`)).toBe(cid);
    expect(parseIpfsUri(cid)).toBe(cid);
    expect(parseIpfsUri("https://example.com/x")).toBeNull();
    expect(parseIpfsUri(null)).toBeNull();
  });
});
