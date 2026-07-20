import type {ContractTerms} from "@actp/core";
import type {Hex} from "viem";

/** Terms produced by an extractor, before persistence (vendorId attached by the service). */
export type ExtractedTerms = Omit<ContractTerms, "schema" | "vendorId">;

export interface ContractDocument {
  content: string;
  contentHash: Hex;
  docType: "terms_of_service" | "pricing_page" | "refund_policy" | "other";
}

export interface TermExtractor {
  readonly name: string;
  readonly version: string;
  extract(doc: ContractDocument): Promise<ExtractedTerms>;
}

/** Confidence below this marks a field `requiresReview` — surfaced, never asserted. */
export const REVIEW_THRESHOLD = 0.8;
