import {describe, expect, it} from "vitest";
import {canonicalize, hashDocument, verifyDocumentHash, CanonicalizationError} from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({b: 1, a: {d: 2, c: 3}})).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is insensitive to key insertion order", () => {
    const a = {x: 1, y: [{b: 2, a: 1}]};
    const b = {y: [{a: 1, b: 2}], x: 1};
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashDocument(a)).toBe(hashDocument(b));
  });

  it("drops undefined object members, nulls undefined array items", () => {
    expect(canonicalize({a: undefined, b: 1})).toBe('{"b":1}');
    expect(canonicalize([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("serializes strings with JSON escaping", () => {
    expect(canonicalize({a: 'x"\n'})).toBe('{"a":"x\\"\\n"}');
  });

  it("rejects non-finite numbers, BigInt, functions and circular structures", () => {
    expect(() => canonicalize({a: NaN})).toThrow(CanonicalizationError);
    expect(() => canonicalize({a: Infinity})).toThrow(CanonicalizationError);
    expect(() => canonicalize({a: 1n})).toThrow(CanonicalizationError);
    expect(() => canonicalize({a: () => 1})).toThrow(CanonicalizationError);
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => canonicalize(circ)).toThrow(CanonicalizationError);
  });

  it("produces a stable keccak256 hash verifiable with verifyDocumentHash", () => {
    const doc = {schema: "actp.metadata.v1", displayName: "Acme"};
    const h = hashDocument(doc);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verifyDocumentHash({displayName: "Acme", schema: "actp.metadata.v1"}, h)).toBe(true);
    expect(verifyDocumentHash({displayName: "Evil", schema: "actp.metadata.v1"}, h)).toBe(false);
  });
});
