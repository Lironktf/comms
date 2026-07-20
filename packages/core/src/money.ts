/**
 * Fixed-point money for the cross-rail decision layer.
 *
 * Amounts arrive from many rails with different decimal conventions (USD 2dp, USDC 6dp,
 * ETH 18dp). To compare and aggregate them deterministically — and to normalize across
 * currencies for cross-rail budgets — everything is carried as an integer number of
 * "micros" (fixed scale 1e6) in a BigInt. No floating point ever touches money.
 *
 * 1e6 is enough for cent- and stablecoin-micro precision; sub-micro fractions are truncated
 * toward zero at parse time (documented, deterministic).
 */

export const SCALE = 6n;
const SCALE_FACTOR = 1_000_000n; // 10 ** 6

export type Micros = bigint;

/** Parse a non-negative decimal string ("29.99", "0.000001") into micros. */
export function parseAmount(decimal: string): Micros {
  if (!/^\d+(\.\d+)?$/.test(decimal.trim())) {
    throw new MoneyError(`invalid amount: ${JSON.stringify(decimal)}`);
  }
  const trimmed = decimal.trim();
  const dot = trimmed.indexOf(".");
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const frac = dot === -1 ? "" : trimmed.slice(dot + 1);
  const fracPadded = (frac + "000000").slice(0, 6); // pad/truncate to 6 dp
  return BigInt(whole) * SCALE_FACTOR + BigInt(fracPadded || "0");
}

/** Format micros back to a canonical decimal string with trailing zeros trimmed. */
export function formatAmount(micros: Micros): string {
  if (micros < 0n) throw new MoneyError("negative amount");
  const whole = micros / SCALE_FACTOR;
  const frac = micros % SCALE_FACTOR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Convert micros of `from` currency to micros of the normalized budget currency, using a
 * decimal-string rate (units of normalized per 1 unit of `from`). The rate itself is
 * fixed-point at 1e6, so cross-currency budget math stays integer and reproducible.
 */
export function convert(micros: Micros, rateDecimal: string): Micros {
  const rate = parseAmount(rateDecimal); // rate scaled by 1e6
  return (micros * rate) / SCALE_FACTOR;
}

export function add(a: Micros, b: Micros): Micros {
  return a + b;
}

export function gt(a: Micros, b: Micros): boolean {
  return a > b;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}
