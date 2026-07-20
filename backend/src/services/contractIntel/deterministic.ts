import type {ExtractedField, SourceReference} from "@actp/core";
import {
  REVIEW_THRESHOLD,
  type ContractDocument,
  type ExtractedTerms,
  type TermExtractor,
} from "./extractor.js";

/**
 * Deterministic pattern-based term extraction (ACTP V4 fallback path).
 *
 * No network calls, fully reproducible: same document -> same terms. Confidences are
 * deliberately conservative (patterns can misread legal prose); most fields land below
 * the review threshold and are flagged `requiresReview`. This extractor also serves as
 * the test baseline for the pipeline.
 */
export class DeterministicExtractor implements TermExtractor {
  readonly name = "deterministic";
  readonly version = "1.0.0";

  async extract(doc: ContractDocument): Promise<ExtractedTerms> {
    const text = doc.content;
    const lower = text.toLowerCase();
    const now = new Date().toISOString();

    const ref = (match: RegExpMatchArray): SourceReference[] => [
      {
        documentHash: doc.contentHash,
        excerpt: excerptAround(text, match.index ?? 0, match[0]?.length ?? 0),
        offset: match.index ?? 0,
      },
    ];

    const field = <T>(value: T, confidence: number, references: SourceReference[]): ExtractedField<T> => ({
      value,
      confidence,
      source: "deterministic_parse",
      references,
      ...(confidence < REVIEW_THRESHOLD ? {requiresReview: true} : {}),
    });

    const terms: ExtractedTerms = {
      extractorVersion: `${this.name}@${this.version}`,
      extractedAt: now,
    };

    // --- free trial -----------------------------------------------------
    const trial = lower.match(/(\d{1,3})[- ]day(?:s)?\s+(?:free\s+)?trial|free\s+trial\s+(?:of|for)\s+(\d{1,3})\s+days?/);
    if (trial) {
      const days = Number(trial[1] ?? trial[2]);
      if (Number.isFinite(days) && days > 0) terms.trialDays = field(days, 0.7, ref(trial));
    }

    // --- renewal cadence / auto-renew ------------------------------------
    const autoRenew = lower.match(/automatic(?:ally)?\s+renew|auto[- ]renew|renews?\s+automatically/);
    if (autoRenew) terms.autoRenews = field(true, 0.75, ref(autoRenew));

    const monthly = lower.match(/renew(?:s|al)?[^.]{0,60}(?:each|every|per)\s+month|monthly\s+(?:subscription|plan|billing)/);
    const annual = lower.match(/renew(?:s|al)?[^.]{0,60}(?:each|every|per)\s+(?:year|annum)|annual(?:ly)?\s+(?:subscription|plan|billing)/);
    if (monthly && !annual) terms.renewalCadence = field("monthly", 0.6, ref(monthly));
    else if (annual && !monthly) terms.renewalCadence = field("annual", 0.6, ref(annual));
    else if (annual && monthly) terms.renewalCadence = field("other", 0.4, [...ref(monthly), ...ref(annual)]);

    // --- renewal price ----------------------------------------------------
    const renewalPrice = text.match(/renew(?:s|al)?[^.]{0,80}?(?:at|of|for)\s+(?:USD\s*)?\$(\d+(?:\.\d{2})?)/i);
    if (renewalPrice?.[1]) {
      terms.renewalPrice = field({amount: renewalPrice[1], currency: "USD"}, 0.55, ref(renewalPrice));
    }

    // --- cancellation method ----------------------------------------------
    const selfService = lower.match(/cancel\s+(?:at\s+any\s+time\s+|anytime\s+)?(?:from|in|via|through)\s+(?:your\s+)?(?:account|dashboard|settings|billing\s+portal)/);
    const byEmail = lower.match(/cancel[^.]{0,80}?(?:by|via)\s+(?:sending\s+an?\s+)?email/);
    const byPhone = lower.match(/cancel[^.]{0,80}?(?:by|via)\s+(?:phone|calling)/);
    const written = lower.match(/cancel[^.]{0,80}?written\s+notice/);
    if (selfService) terms.cancellationMethod = field("self_service", 0.7, ref(selfService));
    else if (written) terms.cancellationMethod = field("written_notice", 0.65, ref(written));
    else if (byEmail) terms.cancellationMethod = field("email", 0.65, ref(byEmail));
    else if (byPhone) terms.cancellationMethod = field("phone", 0.65, ref(byPhone));

    // --- cancellation deadline ---------------------------------------------
    const deadline = lower.match(/(?:at\s+least\s+)?(\d{1,3})\s+days?\s+(?:before|prior\s+to)\s+(?:the\s+)?(?:renewal|end\s+of\s+(?:the\s+)?(?:current\s+)?(?:term|billing))/);
    if (deadline?.[1]) terms.cancellationDeadlineDays = field(Number(deadline[1]), 0.7, ref(deadline));

    // --- refund policy -------------------------------------------------------
    const noRefund = lower.match(/no\s+refunds?|non[- ]refundable|not\s+(?:be\s+)?refund/);
    const refundWindow = lower.match(/refund[^.]{0,80}?within\s+(\d{1,3})\s+days?|(\d{1,3})[- ]day\s+(?:money[- ]back|refund)/);
    const prorated = lower.match(/pro[- ]?rat(?:ed|a)\s+refund/);
    if (refundWindow) {
      const days = Number(refundWindow[1] ?? refundWindow[2]);
      terms.refundPolicy = field({type: "conditional" as const, windowDays: days}, 0.65, ref(refundWindow));
    } else if (prorated) {
      terms.refundPolicy = field({type: "prorated" as const}, 0.6, ref(prorated));
    } else if (noRefund) {
      terms.refundPolicy = field({type: "none" as const}, 0.7, ref(noRefund));
    }

    // --- early termination fee ----------------------------------------------
    const etf = lower.match(/early\s+termination\s+fee|fee\s+for\s+early\s+termination/);
    if (etf) {
      const amount = text.slice(etf.index ?? 0, (etf.index ?? 0) + 160).match(/\$(\d+(?:\.\d{2})?)/);
      terms.earlyTerminationFee = field(
        {present: true, ...(amount?.[1] ? {amount: amount[1], currency: "USD"} : {})},
        0.7,
        ref(etf),
      );
    }

    // --- price increase clause -------------------------------------------------
    const priceIncrease = lower.match(/(?:we\s+(?:may|reserve\s+the\s+right\s+to)\s+(?:change|increase|modify|adjust)\s+(?:our\s+|the\s+)?(?:prices?|fees?|rates?))|price\s+(?:changes?|increases?)\s+(?:may|will)/);
    if (priceIncrease) {
      const notice = lower.slice(priceIncrease.index ?? 0, (priceIncrease.index ?? 0) + 200).match(/(\d{1,3})\s+days?['’]?\s+notice/);
      terms.priceIncreaseClause = field(
        {present: true, ...(notice?.[1] ? {noticeDays: Number(notice[1])} : {})},
        0.7,
        ref(priceIncrease),
      );
    }

    // --- arbitration clause -------------------------------------------------------
    const arbitration = lower.match(/binding\s+arbitration|resolved\s+(?:by|through)\s+arbitration|agree\s+to\s+arbitrate/);
    if (arbitration) {
      const classWaiver = /class\s+action\s+waiver|waive\s+[^.]{0,60}class\s+action/.test(lower);
      terms.arbitrationClause = field(
        {present: true, binding: /binding/.test(arbitration[0] ?? ""), classActionWaiver: classWaiver},
        0.75,
        ref(arbitration),
      );
    }

    return terms;
  }
}

function excerptAround(text: string, offset: number, matchLen: number): string {
  const start = Math.max(0, offset - 60);
  const end = Math.min(text.length, offset + matchLen + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
