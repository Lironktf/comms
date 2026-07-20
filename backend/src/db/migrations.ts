import type {Db} from "./client.js";

/**
 * Ordered, append-only migrations. Applied migrations are recorded in schema_migrations;
 * never edit an existing entry — add a new one.
 */
const MIGRATIONS: {id: string; sql: string}[] = [
  {
    id: "001_init",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- indexer
CREATE TABLE IF NOT EXISTS indexer_state (
  id TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  last_block_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw event audit trail (idempotency key: tx_hash + log_index).
CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  contract TEXT NOT NULL,
  event_name TEXT NOT NULL,
  args JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block_idx ON chain_events (block_number);

-- ---------------------------------------------------------------- V1 vendors
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  primary_domain TEXT NOT NULL,
  x402_endpoint TEXT,
  metadata_hash TEXT,
  metadata_uri TEXT,
  metadata_version BIGINT NOT NULL DEFAULT 0,
  contract_metadata_hash TEXT,
  contract_metadata_version BIGINT NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  registered_block BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS vendors_primary_domain_idx ON vendors (primary_domain);

CREATE TABLE IF NOT EXISTS vendor_domains (
  domain TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors (vendor_id)
);
CREATE INDEX IF NOT EXISTS vendor_domains_vendor_idx ON vendor_domains (vendor_id);

CREATE TABLE IF NOT EXISTS vendor_wallets (
  wallet TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors (vendor_id)
);
CREATE INDEX IF NOT EXISTS vendor_wallets_vendor_idx ON vendor_wallets (vendor_id);

-- ---------------------------------------------------------------- V2 attestations
CREATE TABLE IF NOT EXISTS attestations (
  attestation_id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors (vendor_id),
  att_type INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attester TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoke_reason TEXT,
  block_number BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS attestations_vendor_idx ON attestations (vendor_id, att_type);

CREATE TABLE IF NOT EXISTS attester_bans (
  attester TEXT PRIMARY KEY,
  issued_at_cutoff TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------- V3 metadata
CREATE TABLE IF NOT EXISTS metadata_documents (
  vendor_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  document JSONB NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, version)
);

-- ---------------------------------------------------------------- V4 contract intelligence
CREATE TABLE IF NOT EXISTS contract_documents (
  content_hash TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('terms_of_service','pricing_page','refund_policy','other')),
  source_url TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_documents_vendor_idx ON contract_documents (vendor_id);

CREATE TABLE IF NOT EXISTS contract_terms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  document_hash TEXT NOT NULL REFERENCES contract_documents (content_hash),
  terms JSONB NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_terms_vendor_idx ON contract_terms (vendor_id, created_at DESC);

-- ---------------------------------------------------------------- V5 risk
CREATE TABLE IF NOT EXISTS risk_signals (
  vendor_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  value JSONB NOT NULL,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, signal)
);

CREATE TABLE IF NOT EXISTS risk_scores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  score INTEGER NOT NULL,
  reasons JSONB NOT NULL,
  ruleset_version TEXT NOT NULL,
  inputs_snapshot_hash TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_scores_vendor_idx ON risk_scores (vendor_id, evaluated_at DESC);
`,
  },
  {
    id: "002_metadata_cid",
    sql: `
-- Content-addressed identifier (IPFS CIDv1) of the canonical metadata document.
ALTER TABLE metadata_documents ADD COLUMN IF NOT EXISTS cid TEXT;
`,
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  for (const m of MIGRATIONS) {
    const done = await db.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [m.id]);
    if (done.rows.length > 0) continue;
    await db.tx(async (q) => {
      // PGlite/pg both accept multi-statement exec via query for DDL batches
      for (const stmt of m.sql.split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean)) {
        await q(stmt);
      }
      await q(`INSERT INTO schema_migrations (id) VALUES ($1)`, [m.id]);
    });
  }
}
