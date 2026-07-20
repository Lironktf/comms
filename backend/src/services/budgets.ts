import {randomUUID} from "node:crypto";
import {convert, formatAmount, parseAmount, type Micros, type Money} from "@actp/core";
import type {Db} from "../db/client.js";
import {HttpError} from "./metadata.js";

/**
 * ACTP V6 — cross-rail budgets with two-phase hold/settle.
 *
 * This is the load-bearing cross-rail primitive: a department cap of "$10k/month" is enforced
 * across a card charge in USD, a stablecoin payment in USDC, and an A2A settlement in EUR
 * simultaneously, because every amount is normalized (via FX) into the budget's currency and
 * counted against one limit. On ALLOW the decision places a hold against every applicable
 * budget in the principal's chain, atomically — so two agents sharing one treasury cannot
 * both slip under the cap. Holds settle on confirmation, release on cancel, expire on TTL.
 */

export type BudgetPeriod = "day" | "month" | "total";

export interface Budget {
  id: string;
  principalId: string;
  period: BudgetPeriod;
  currency: string;
  limitMicros: Micros;
}

export interface HoldOutcome {
  ok: boolean;
  holdIds: string[];
  /** populated when ok === false */
  violation?: {budgetId: string; period: BudgetPeriod; limit: string; wouldBe: string; currency: string};
  /** per-budget usage snapshot for explainability */
  usage: {budgetId: string; period: BudgetPeriod; used: string; limit: string; currency: string}[];
}

export class FxUnavailableError extends Error {
  constructor(public readonly currency: string) {
    super(`no FX rate configured for ${currency}`);
    this.name = "FxUnavailableError";
  }
}

export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly fxRates: Map<string, string>,
    private readonly holdTtlSeconds: number,
  ) {}

  async createBudget(
    principalId: string,
    period: BudgetPeriod,
    currency: string,
    limitDecimal: string,
  ): Promise<Budget> {
    const id = `bud_${randomUUID().slice(0, 12)}`;
    const limitMicros = parseAmount(limitDecimal);
    await this.db.query(
      `INSERT INTO budgets (id, principal_id, period, currency, limit_micros) VALUES ($1,$2,$3,$4,$5)`,
      [id, principalId, period, currency.toUpperCase(), limitMicros.toString()],
    );
    return {id, principalId, period, currency: currency.toUpperCase(), limitMicros};
  }

  /** Normalize a rail amount into a target currency using the configured FX table. */
  normalize(amount: Money, target: string): {micros: Micros; rate: string} {
    const from = amount.currency.toUpperCase();
    const to = target.toUpperCase();
    const original = parseAmount(amount.value);
    if (from === to) return {micros: original, rate: "1"};
    const fromRate = this.fxRates.get(from);
    const toRate = this.fxRates.get(to);
    if (!fromRate) throw new FxUnavailableError(from);
    if (!toRate) throw new FxUnavailableError(to);
    // rate(from->to) = fromRate / toRate ; do it in fixed point via convert with a derived rate
    // micros_to = micros_from * fromRate / toRate
    const inNormalized = convert(original, fromRate); // from -> normalized base
    const micros = divideByRate(inNormalized, toRate); // normalized base -> to
    const effectiveRate = formatAmount(divideByRate(convert(parseAmount("1"), fromRate), toRate));
    return {micros, rate: effectiveRate};
  }

  /**
   * Atomically check every budget in `principalChainIds` and place holds if all pass.
   * Returns ok=false with the first violation (no holds placed) otherwise.
   */
  async checkAndHold(
    principalChainIds: string[],
    spendingPrincipalId: string,
    decisionId: string,
    amount: Money,
    now = new Date(),
  ): Promise<HoldOutcome> {
    if (principalChainIds.length === 0) return {ok: true, holdIds: [], usage: []};

    return this.db.tx(async (q) => {
      const placeholders = principalChainIds.map((_, i) => `$${i + 1}`).join(",");
      const budgets = await q<{
        id: string;
        principal_id: string;
        period: BudgetPeriod;
        currency: string;
        limit_micros: string;
      }>(`SELECT * FROM budgets WHERE principal_id IN (${placeholders})`, principalChainIds);

      const usage: HoldOutcome["usage"] = [];
      const toInsert: {budgetId: string; micros: Micros; rate: string}[] = [];

      for (const b of budgets.rows) {
        const {micros: reqMicros, rate} = this.normalize(amount, b.currency);
        const cutoff = periodCutoff(b.period, now);
        const used = await this.usedMicros(q, b.id, cutoff, now);
        const limit = BigInt(b.limit_micros);
        const wouldBe = used + reqMicros;
        usage.push({
          budgetId: b.id,
          period: b.period,
          used: formatAmount(used),
          limit: formatAmount(limit),
          currency: b.currency,
        });
        if (wouldBe > limit) {
          // abort: throw to roll back any conceptual work, but we haven't inserted yet
          return {
            ok: false,
            holdIds: [],
            usage,
            violation: {
              budgetId: b.id,
              period: b.period,
              limit: formatAmount(limit),
              wouldBe: formatAmount(wouldBe),
              currency: b.currency,
            },
          };
        }
        toInsert.push({budgetId: b.id, micros: reqMicros, rate});
      }

      const holdIds: string[] = [];
      const expiresAt = new Date(now.getTime() + this.holdTtlSeconds * 1000);
      for (const ins of toInsert) {
        const holdId = `hold_${randomUUID().slice(0, 12)}`;
        await q(
          `INSERT INTO budget_holds
             (id, budget_id, decision_id, principal_id, amount_micros, original_currency, original_micros, rate, status, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'held',$9)`,
          [
            holdId,
            ins.budgetId,
            decisionId,
            spendingPrincipalId,
            ins.micros.toString(),
            amount.currency.toUpperCase(),
            parseAmount(amount.value).toString(),
            ins.rate,
            expiresAt,
          ],
        );
        holdIds.push(holdId);
      }
      return {ok: true, holdIds, usage};
    });
  }

  async settle(decisionId: string, now = new Date()): Promise<number> {
    const res = await this.db.query(
      `UPDATE budget_holds SET status = 'settled', settled_at = $2 WHERE decision_id = $1 AND status = 'held'`,
      [decisionId, now],
    );
    return res.rowCount;
  }

  async release(decisionId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE budget_holds SET status = 'released' WHERE decision_id = $1 AND status = 'held'`,
      [decisionId],
    );
    return res.rowCount;
  }

  async listBudgets(principalId: string): Promise<Budget[]> {
    const res = await this.db.query<{
      id: string;
      principal_id: string;
      period: BudgetPeriod;
      currency: string;
      limit_micros: string;
    }>(`SELECT * FROM budgets WHERE principal_id = $1`, [principalId]);
    return res.rows.map((b) => ({
      id: b.id,
      principalId: b.principal_id,
      period: b.period,
      currency: b.currency,
      limitMicros: BigInt(b.limit_micros),
    }));
  }

  /** Sum of live holds (held-and-unexpired or settled) in the period window. */
  private async usedMicros(q: Db["query"], budgetId: string, cutoff: Date | null, now: Date): Promise<Micros> {
    const params: unknown[] = [budgetId];
    let sql = `SELECT amount_micros, status, expires_at FROM budget_holds WHERE budget_id = $1`;
    if (cutoff) {
      sql += ` AND created_at >= $2`;
      params.push(cutoff);
    }
    const res = await q<{amount_micros: string; status: string; expires_at: string | Date}>(sql, params);
    let total = 0n;
    for (const h of res.rows) {
      if (h.status === "settled") total += BigInt(h.amount_micros);
      else if (h.status === "held" && new Date(h.expires_at) > now) total += BigInt(h.amount_micros);
    }
    return total;
  }
}

function periodCutoff(period: BudgetPeriod, now: Date): Date | null {
  if (period === "total") return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === "day" ? now.getUTCDate() : 1));
  return d;
}

/** micros / rate, both fixed-point 1e6. */
function divideByRate(micros: Micros, rateDecimal: string): Micros {
  const rate = parseAmount(rateDecimal); // scaled 1e6
  if (rate === 0n) throw new Error("zero FX rate");
  return (micros * 1_000_000n) / rate;
}
