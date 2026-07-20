import {describe, expect, it} from "vitest";
import {keccak256, toBytes} from "viem";
import {DeterministicExtractor} from "./deterministic.js";

const TOS = `
Acme Cloud Terms of Service

1. Subscriptions. All paid plans begin with a 14-day free trial. After the trial, your
subscription will automatically renew each month at $29.99 unless cancelled.

2. Cancellation. You may cancel at any time from your account dashboard. To avoid being
charged for the next period, you must cancel at least 5 days before the renewal date.

3. Refunds. We offer refunds within 30 days of purchase. After that, fees are non-refundable.

4. Pricing. We reserve the right to change our prices with 30 days' notice.

5. Termination. An early termination fee of $50 applies to annual commitments.

6. Disputes. Any dispute shall be resolved through binding arbitration. You waive any right
to participate in a class action lawsuit or class action waiver proceedings.
`;

const doc = {
  content: TOS,
  contentHash: keccak256(toBytes(TOS)),
  docType: "terms_of_service" as const,
};

describe("DeterministicExtractor", () => {
  const extractor = new DeterministicExtractor();

  it("extracts the full term set from a well-formed ToS", async () => {
    const terms = await extractor.extract(doc);

    expect(terms.trialDays?.value).toBe(14);
    expect(terms.autoRenews?.value).toBe(true);
    expect(terms.renewalCadence?.value).toBe("monthly");
    expect(terms.renewalPrice?.value).toEqual({amount: "29.99", currency: "USD"});
    expect(terms.cancellationMethod?.value).toBe("self_service");
    expect(terms.cancellationDeadlineDays?.value).toBe(5);
    expect(terms.refundPolicy?.value).toEqual({type: "conditional", windowDays: 30});
    expect(terms.earlyTerminationFee?.value).toEqual({present: true, amount: "50", currency: "USD"});
    expect(terms.priceIncreaseClause?.value).toEqual({present: true, noticeDays: 30});
    expect(terms.arbitrationClause?.value).toEqual({
      present: true,
      binding: true,
      classActionWaiver: true,
    });
  });

  it("every field carries provenance, confidence and a source reference", async () => {
    const terms = await extractor.extract(doc);
    for (const [key, value] of Object.entries(terms)) {
      if (key === "extractorVersion" || key === "extractedAt") continue;
      const f = value as {confidence: number; source: string; references: {documentHash: string; excerpt?: string}[]};
      expect(f.source).toBe("deterministic_parse");
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.references[0]?.documentHash).toBe(doc.contentHash);
      expect(f.references[0]?.excerpt).toBeTruthy();
    }
  });

  it("never presents pattern extraction as certain: sub-threshold fields require review", async () => {
    const terms = await extractor.extract(doc);
    const price = terms.renewalPrice;
    expect(price).toBeDefined();
    expect(price!.confidence).toBeLessThan(0.8);
    expect(price!.requiresReview).toBe(true);
  });

  it("returns no terms for a document that states none", async () => {
    const empty = "Welcome to our website. We sell shoes. Contact us at shop@example.com.";
    const terms = await extractor.extract({
      content: empty,
      contentHash: keccak256(toBytes(empty)),
      docType: "other",
    });
    expect(terms.trialDays).toBeUndefined();
    expect(terms.autoRenews).toBeUndefined();
    expect(terms.refundPolicy).toBeUndefined();
    expect(terms.arbitrationClause).toBeUndefined();
  });

  it("is deterministic across runs", async () => {
    const a = await extractor.extract(doc);
    const b = await extractor.extract(doc);
    // extractedAt varies; everything else must match
    const strip = (t: object) => JSON.parse(JSON.stringify({...t, extractedAt: null}));
    expect(strip(a)).toEqual(strip(b));
  });
});
