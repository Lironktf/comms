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
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
