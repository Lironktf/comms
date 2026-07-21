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

describe("computeCid — independent known-answer cross-check", () => {
  // RFC 4648 base32 (lowercase, no padding) — multibase 'b'. Re-implemented here so we validate
  // computeCid against a hand-built CID, not against multiformats' own encoder.
  const B32 = "abcdefghijklmnopqrstuvwxyz234567";
  function base32(bytes: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += B32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  it("matches a hand-constructed CIDv1(raw, sha2-256)", async () => {
    const msg = new TextEncoder().encode("acme.example canonical bytes");
    // CID bytes = <cidv1=0x01><raw codec=0x55><sha2-256=0x12><len=0x20><32-byte digest>
    const digest = createHash("sha256").update(Buffer.from(msg)).digest();
    const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
    const expected = "b" + base32(cidBytes);
    expect(await computeCid(msg)).toBe(expected);
  });

  it("stays 59 chars for typical content (CIDv1 raw base32)", async () => {
    const cid = await computeCid(new TextEncoder().encode("hello"));
    expect(cid.length).toBe(59);
    expect(cid[0]).toBe("b");
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
