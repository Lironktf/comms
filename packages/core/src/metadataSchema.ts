import {z} from "zod";

/**
 * ACTP V3 — merchant metadata document, version 1.
 *
 * The document is published offchain, canonicalized (RFC 8785 subset, see canonical.ts),
 * keccak256-hashed, and the hash anchored onchain via VendorRegistry.setMetadata. Numbers are
 * restricted to integers so canonical number formatting can never diverge between clients.
 */

const domainRe = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const countryRe = /^[A-Z]{2}$/;
/** CAIP-2 chain id, e.g. "eip155:8453" */
const caip2Re = /^[a-z0-9-]{3,8}:[a-zA-Z0-9_.-]{1,32}$/;

export const paymentRailSchema = z.enum(["x402", "card", "ach", "sepa", "crypto", "other"]);

export const merchantMetadataSchema = z
  .object({
    schema: z.literal("actp.metadata.v1"),
    /** binds the document to the registry record */
    primaryDomain: z.string().regex(domainRe),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    categories: z.array(z.string().min(1).max(64).regex(/^[a-z0-9-]+$/)).min(1).max(20),
    paymentMethods: z
      .array(
        z.object({
          rail: paymentRailSchema,
          details: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(20),
    capabilities: z.object({
      subscriptions: z.boolean(),
      recurringBilling: z.boolean(),
      refunds: z.boolean(),
      apiProvider: z.boolean(),
      saas: z.boolean(),
      digitalGoods: z.boolean(),
      physicalGoods: z.boolean(),
    }),
    countriesServed: z.array(z.string().regex(countryRe)).max(300).optional(),
    taxSupport: z
      .object({
        vatInvoices: z.boolean().optional(),
        taxIdCollection: z.boolean().optional(),
      })
      .optional(),
    x402: z
      .object({
        endpoint: z.string().url().max(500),
        networks: z.array(z.string().regex(caip2Re)).min(1).max(50),
        assets: z.array(z.string().min(1).max(100)).min(1).max(50),
      })
      .optional(),
    contact: z
      .object({
        email: z.string().email().max(320).optional(),
        url: z.string().url().max(500).optional(),
        supportUrl: z.string().url().max(500).optional(),
      })
      .optional(),
  })
  .strict();

export type MerchantMetadata = z.infer<typeof merchantMetadataSchema>;

/** Hard cap on serialized document size — malicious oversized metadata is rejected outright. */
export const MAX_METADATA_BYTES = 64 * 1024;

export function validateMerchantMetadata(doc: unknown): MerchantMetadata {
  const size = Buffer.byteLength(JSON.stringify(doc ?? null), "utf8");
  if (size > MAX_METADATA_BYTES) {
    throw new Error(`metadata document exceeds ${MAX_METADATA_BYTES} bytes (got ${size})`);
  }
  return merchantMetadataSchema.parse(doc);
}
