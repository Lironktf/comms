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
  {
    id: "003_decision_layer",
    sql: `
-- ---------------------------------------------------------------- V7/V9 principals
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('org','department','agent')),
  parent_id TEXT REFERENCES principals (id),
  org_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  policy_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS principals_parent_idx ON principals (parent_id);
CREATE INDEX IF NOT EXISTS principals_org_idx ON principals (org_id);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  version TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_principal_idx ON policies (principal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  from_principal TEXT NOT NULL REFERENCES principals (id),
  to_principal TEXT NOT NULL REFERENCES principals (id),
  constraints JSONB NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delegations_to_idx ON delegations (to_principal) WHERE revoked = FALSE;

-- ---------------------------------------------------------------- V6 budgets (cross-rail)
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  period TEXT NOT NULL CHECK (period IN ('day','month','total')),
  currency TEXT NOT NULL,
  limit_micros TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budgets_principal_idx ON budgets (principal_id);

-- A hold is placed on ALLOW (or approval) and settled on confirmation. Cross-rail: a card
-- USD charge and a USDC x402 payment both normalize into amount_micros against the same budget.
CREATE TABLE IF NOT EXISTS budget_holds (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  decision_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  amount_micros TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  original_micros TEXT NOT NULL,
  rate TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','settled','released','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS budget_holds_budget_idx ON budget_holds (budget_id, status, created_at);
CREATE INDEX IF NOT EXISTS budget_holds_decision_idx ON budget_holds (decision_id);

-- ---------------------------------------------------------------- V12 decisions
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  amount JSONB NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allow','deny','require_approval')),
  vendor_id TEXT,
  verification_level INTEGER,
  risk_level TEXT,
  risk_score INTEGER,
  policy_version TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  reasons JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_idempotency ON decisions (principal_id, request_id);
CREATE INDEX IF NOT EXISTS decisions_org_idx ON decisions (org_id, created_at DESC);

-- ---------------------------------------------------------------- V8 approvals
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  amount JSONB NOT NULL,
  context JSONB NOT NULL,
  token_payload JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolver TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS approvals_org_idx ON approvals (org_id, status, requested_at DESC);

-- ---------------------------------------------------------------- V13 receipts (hash chain)
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  prev_hash TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('decision','approval','settlement','dispute')),
  payload JSONB NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_chain ON receipts (org_id, seq);
CREATE INDEX IF NOT EXISTS receipts_org_idx ON receipts (org_id, seq DESC);

-- ---------------------------------------------------------------- V10 settlements (reputation input)
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  vendor_id TEXT,
  principal_id TEXT NOT NULL,
  verification_level INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('fulfilled','disputed','refunded','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlements_vendor_idx ON settlements (vendor_id);
`,
  },
  {
    id: "004_bazaar",
    sql: `
-- Ingested x402 Bazaar-style listings (raw). Vetting joins these against the registry at read time.
CREATE TABLE IF NOT EXISTS bazaar_listings (
  id TEXT PRIMARY KEY,
  resource_url TEXT NOT NULL,
  pay_to TEXT,
  domain TEXT,
  service_name TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  price JSONB,
  source TEXT NOT NULL DEFAULT 'ingest',
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bazaar_pay_to_idx ON bazaar_listings (pay_to);
`,
  },
  {
    id: "005_kyb",
    sql: `
-- Know-Your-Business check results. A passed check is what a verifier turns into an onchain
-- level-3 (LegalEntityVerified) attestation; the raw evidence stays offchain.
CREATE TABLE IF NOT EXISTS kyb_checks (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  provider TEXT NOT NULL,
  legal_name TEXT,
  registration_id TEXT,
  jurisdiction TEXT,
  evidence_hash TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyb_checks_vendor_idx ON kyb_checks (vendor_id, checked_at DESC);
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
