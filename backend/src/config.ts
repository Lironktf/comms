import {z} from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8402),
  HOST: z.string().default("0.0.0.0"),
  /** Empty => embedded PGlite (dev/test). */
  DATABASE_URL: z.string().optional(),
  RPC_URL: z.string().default("http://127.0.0.1:8545"),
  CHAIN_ID: z.coerce.number().default(31337),
  VENDOR_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ATTESTATION_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Block the contracts were deployed at; indexing starts here. */
  DEPLOY_BLOCK: z.coerce.number().default(0),
  /** Confirmations before a block is considered settled by the indexer. */
  INDEXER_CONFIRMATIONS: z.coerce.number().default(2),
  INDEXER_POLL_MS: z.coerce.number().default(2000),
  /** Blocks to rewind when a reorg is detected at the checkpoint. */
  INDEXER_REORG_DEPTH: z.coerce.number().default(64),
  /** API key required for admin/mutating endpoints (risk signals, extraction triggers). */
  ADMIN_API_KEY: z.string().optional(),
  /** Content-addressed document storage. 'memory' (default, in-process) or 'kubo' (self-hosted IPFS node). */
  IPFS_MODE: z.enum(["memory", "kubo"]).default("memory"),
  IPFS_API_URL: z.string().default("http://127.0.0.1:5001"),
  /** Public gateway used by clients to fetch documents by CID. */
  IPFS_GATEWAY_URL: z.string().default("http://127.0.0.1:8080"),
  /** 'deterministic' (default, no external calls) or 'llm'. */
  CONTRACT_EXTRACTOR: z.enum(["deterministic", "llm"]).default("deterministic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model used by the LLM extractor when enabled. */
  EXTRACTOR_MODEL: z.string().default("claude-opus-4-8"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // --- V6–V13 decision layer ---
  /** Ed25519 PKCS8 PEM used to sign decision tokens. Empty => ephemeral key (dev only). */
  DECISION_SIGNING_KEY: z.string().optional(),
  /** Currency all budgets and policy amount thresholds normalize to. */
  NORMALIZED_CURRENCY: z.string().default("USD"),
  /** JSON map of currency/asset -> decimal rate in NORMALIZED_CURRENCY per 1 unit. */
  FX_RATES: z
    .string()
    .default('{"USD":"1","USDC":"1","EURC":"1.08","EUR":"1.08"}')
    .transform((s, ctx) => {
      try {
        const obj = JSON.parse(s) as Record<string, string>;
        return new Map(Object.entries(obj).map(([k, v]) => [k.toUpperCase(), v]));
      } catch {
        ctx.addIssue({code: "custom", message: "FX_RATES must be a JSON object of currency->rate"});
        return new Map<string, string>();
      }
    }),
  /** Seconds a budget hold and its decision token remain valid before expiring (fail closed). */
  DECISION_TOKEN_TTL_SECONDS: z.coerce.number().default(600),
  /** Seconds a human-approval request stays pending before it expires. */
  APPROVAL_TTL_SECONDS: z.coerce.number().default(86400),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
