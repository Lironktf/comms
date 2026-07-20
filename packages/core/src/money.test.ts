import {describe, expect, it} from "vitest";
import {parseAmount, formatAmount, convert, gt, MoneyError} from "./money.js";

describe("money", () => {
  it("round-trips decimal strings through micros", () => {
    for (const v of ["0", "1", "29.99", "0.000001", "1000000.5", "0.1"]) {
      expect(formatAmount(parseAmount(v))).toBe(normalize(v));
    }
  });

  it("truncates sub-micro precision deterministically", () => {
    expect(formatAmount(parseAmount("0.1234567"))).toBe("0.123456");
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", "1e6", " "]) {
      expect(() => parseAmount(bad)).toThrow(MoneyError);
    }
  });

  it("compares without floating-point error", () => {
    // 0.1 + 0.2 style hazard — exact in fixed point
    expect(gt(parseAmount("0.3"), parseAmount("0.30"))).toBe(false);
    expect(gt(parseAmount("250.01"), parseAmount("250"))).toBe(true);
  });

  it("converts across currencies with a fixed-point rate", () => {
    // 100 USDC at rate 1.0 -> 100 USD-equivalent
    expect(formatAmount(convert(parseAmount("100"), "1"))).toBe("100");
    // 100 EUR at 1.08 -> 108
    expect(formatAmount(convert(parseAmount("100"), "1.08"))).toBe("108");
    // large stablecoin micro amount
    expect(formatAmount(convert(parseAmount("0.000001"), "1"))).toBe("0.000001");
  });
});

function normalize(v: string): string {
  // expected canonical form (trailing-zero trimmed)
  if (!v.includes(".")) return v;
  const t = v.replace(/0+$/, "").replace(/\.$/, "");
  return t === "" ? "0" : t;
}
