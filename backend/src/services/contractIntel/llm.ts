import Anthropic from "@anthropic-ai/sdk";
import {zodOutputFormat} from "@anthropic-ai/sdk/helpers/zod";
import {z} from "zod";
import type {ExtractedField, SourceReference} from "@actp/core";
import {
  REVIEW_THRESHOLD,
  type ContractDocument,
  type ExtractedTerms,
  type TermExtractor,
} from "./extractor.js";

/**
 * LLM-based term extraction (ACTP V4, optional path — enabled with
 * CONTRACT_EXTRACTOR=llm + ANTHROPIC_API_KEY).
 *
 * Every extracted field records source="ai_extracted", the model's self-reported
 * confidence (clamped, and capped below verifier-grade certainty), and the verbatim
 * supporting quote from the document. Output is schema-enforced via structured outputs,
 * so responses always parse. AI output is NEVER stored or served as verified fact.
 */

const extractedString = (desc: string) =>
  z.object({
    value: z.string().describe(desc),
    confidence: z.number().describe("Extraction confidence in [0,1]. Be conservative."),
    quote: z.string().describe("Verbatim supporting quote from the document (max ~200 chars)."),
  });

const extractedNumber = (desc: string) =>
  z.object({
    value: z.number().describe(desc),
    confidence: z.number(),
    quote: z.string(),
  });

const extractionSchema = z.object({
  trialDays: extractedNumber("Length of the free trial in days").nullable(),
  renewalCadence: z
    .object({
      value: z.enum(["monthly", "annual", "none", "other"]),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
  renewalPriceAmount: extractedString("Renewal price amount as a decimal string, e.g. '29.99'").nullable(),
  renewalPriceCurrency: z.string().nullable().describe("ISO 4217 currency of the renewal price, if stated"),
  autoRenews: z
    .object({value: z.boolean(), confidence: z.number(), quote: z.string()})
    .nullable()
    .describe("Whether the subscription renews automatically"),
  cancellationMethod: z
    .object({
      value: z.enum(["self_service", "email", "phone", "written_notice", "other"]),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
  cancellationDeadlineDays: extractedNumber(
    "Days before renewal by which cancellation must occur",
  ).nullable(),
  refundPolicy: z
    .object({
      value: z.object({
        type: z.enum(["full", "prorated", "none", "conditional"]),
        windowDays: z.number().nullable(),
      }),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
  earlyTerminationFee: z
    .object({
      value: z.object({present: z.boolean(), amount: z.string().nullable(), currency: z.string().nullable()}),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
  priceIncreaseClause: z
    .object({
      value: z.object({present: z.boolean(), noticeDays: z.number().nullable()}),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
  arbitrationClause: z
    .object({
      value: z.object({present: z.boolean(), binding: z.boolean().nullable(), classActionWaiver: z.boolean().nullable()}),
      confidence: z.number(),
      quote: z.string(),
    })
    .nullable(),
});

const SYSTEM_PROMPT = `You extract commercial contract terms from merchant documents (terms of service, pricing pages, refund policies) for an autonomous-commerce trust registry.

Rules:
- Extract ONLY what the document actually states. Never infer industry norms or fill gaps.
- If a term is not present or is ambiguous, return null for that field.
- Confidence must reflect how explicitly and unambiguously the document states the term. Reserve >0.9 for verbatim, unambiguous statements.
- Quotes must be verbatim substrings of the document supporting the extraction.`;

// AI-extracted facts are capped below certainty: certainty is reserved for
// merchant-declared or verifier-attested terms.
const MAX_AI_CONFIDENCE = 0.95;

export class LlmExtractor implements TermExtractor {
  readonly name: string;
  readonly version = "1.0.0";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: {apiKey?: string; model?: string} = {}) {
    this.client = new Anthropic(opts.apiKey ? {apiKey: opts.apiKey} : {});
    this.model = opts.model ?? "claude-opus-4-8";
    this.name = `llm:${this.model}`;
  }

  async extract(doc: ContractDocument): Promise<ExtractedTerms> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      thinking: {type: "adaptive"},
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Document type: ${doc.docType}\n\n<document>\n${doc.content.slice(0, 200_000)}\n</document>\n\nExtract the contract terms.`,
        },
      ],
      output_config: {format: zodOutputFormat(extractionSchema)},
    });

    const out = response.parsed_output;
    if (!out) throw new Error("LLM extraction returned unparseable output");

    const terms: ExtractedTerms = {
      extractorVersion: `${this.name}@${this.version}`,
      extractedAt: new Date().toISOString(),
    };

    const toField = <T>(
      value: T,
      confidence: number,
      quote: string,
    ): ExtractedField<T> => {
      const c = Math.min(Math.max(confidence, 0), MAX_AI_CONFIDENCE);
      const references: SourceReference[] = [
        {documentHash: doc.contentHash, excerpt: quote.slice(0, 300)},
      ];
      return {
        value,
        confidence: c,
        source: "ai_extracted",
        references,
        ...(c < REVIEW_THRESHOLD ? {requiresReview: true} : {}),
      };
    };

    if (out.trialDays) terms.trialDays = toField(out.trialDays.value, out.trialDays.confidence, out.trialDays.quote);
    if (out.renewalCadence) {
      terms.renewalCadence = toField(out.renewalCadence.value, out.renewalCadence.confidence, out.renewalCadence.quote);
    }
    if (out.renewalPriceAmount) {
      terms.renewalPrice = toField(
        {amount: out.renewalPriceAmount.value, currency: out.renewalPriceCurrency ?? "USD"},
        out.renewalPriceAmount.confidence,
        out.renewalPriceAmount.quote,
      );
    }
    if (out.autoRenews) terms.autoRenews = toField(out.autoRenews.value, out.autoRenews.confidence, out.autoRenews.quote);
    if (out.cancellationMethod) {
      terms.cancellationMethod = toField(
        out.cancellationMethod.value,
        out.cancellationMethod.confidence,
        out.cancellationMethod.quote,
      );
    }
    if (out.cancellationDeadlineDays) {
      terms.cancellationDeadlineDays = toField(
        out.cancellationDeadlineDays.value,
        out.cancellationDeadlineDays.confidence,
        out.cancellationDeadlineDays.quote,
      );
    }
    if (out.refundPolicy) {
      const v = out.refundPolicy.value;
      terms.refundPolicy = toField(
        {type: v.type, ...(v.windowDays != null ? {windowDays: v.windowDays} : {})},
        out.refundPolicy.confidence,
        out.refundPolicy.quote,
      );
    }
    if (out.earlyTerminationFee) {
      const v = out.earlyTerminationFee.value;
      terms.earlyTerminationFee = toField(
        {present: v.present, ...(v.amount ? {amount: v.amount, currency: v.currency ?? "USD"} : {})},
        out.earlyTerminationFee.confidence,
        out.earlyTerminationFee.quote,
      );
    }
    if (out.priceIncreaseClause) {
      const v = out.priceIncreaseClause.value;
      terms.priceIncreaseClause = toField(
        {present: v.present, ...(v.noticeDays != null ? {noticeDays: v.noticeDays} : {})},
        out.priceIncreaseClause.confidence,
        out.priceIncreaseClause.quote,
      );
    }
    if (out.arbitrationClause) {
      const v = out.arbitrationClause.value;
      terms.arbitrationClause = toField(
        {
          present: v.present,
          ...(v.binding != null ? {binding: v.binding} : {}),
          ...(v.classActionWaiver != null ? {classActionWaiver: v.classActionWaiver} : {}),
        },
        out.arbitrationClause.confidence,
        out.arbitrationClause.quote,
      );
    }

    return terms;
  }
}
