import type {Db} from "../db/client.js";

/**
 * Applies decoded registry events to the derived tables. The derived state is a pure
 * function of the ordered event log (chain_events), so it can always be rebuilt by replay —
 * this is what makes reorg recovery simple and correct.
 */

export interface DecodedEvent {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
  contract: "VendorRegistry" | "AttestationRegistry";
  eventName: string;
  args: Record<string, unknown>;
}

const lower = (v: unknown): string => String(v).toLowerCase();
const tsFromUnix = (v: unknown): Date => new Date(Number(v) * 1000);

export async function storeAndApplyEvent(q: Db["query"], ev: DecodedEvent): Promise<void> {
  const inserted = await q(
    `INSERT INTO chain_events (tx_hash, log_index, block_number, block_hash, block_time, contract, event_name, args)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      ev.txHash,
      ev.logIndex,
      ev.blockNumber.toString(),
      ev.blockHash,
      ev.blockTime,
      ev.contract,
      ev.eventName,
      JSON.stringify(ev.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ],
  );
  if (inserted.rowCount === 0) return; // already processed (idempotent)
  await applyEvent(q, ev);
}

export async function applyEvent(q: Db["query"], ev: DecodedEvent): Promise<void> {
  const a = ev.args;
  switch (ev.eventName) {
    case "VendorRegistered":
      await q(
        `INSERT INTO vendors (vendor_id, owner, status, primary_domain, registered_at, updated_at, registered_block)
         VALUES ($1,$2,'active',$3,$4,$4,$5)
         ON CONFLICT (vendor_id) DO NOTHING`,
        [lower(a.vendorId), lower(a.owner), String(a.primaryDomain), tsFromUnix(a.registeredAt), ev.blockNumber.toString()],
      );
      break;

    case "VendorStatusChanged": {
      const status = ({1: "active", 2: "suspended", 3: "revoked"} as Record<number, string>)[Number(a.newStatus)];
      if (status) {
        await q(`UPDATE vendors SET status = $2, updated_at = $3 WHERE vendor_id = $1`, [
          lower(a.vendorId),
          status,
          ev.blockTime,
        ]);
      }
      break;
    }

    case "VendorOwnershipTransferred":
      await q(`UPDATE vendors SET owner = $2, updated_at = $3 WHERE vendor_id = $1`, [
        lower(a.vendorId),
        lower(a.newOwner),
        ev.blockTime,
      ]);
      break;

    case "DomainAdded":
      await q(
        `INSERT INTO vendor_domains (domain, vendor_id) VALUES ($1,$2)
         ON CONFLICT (domain) DO UPDATE SET vendor_id = EXCLUDED.vendor_id`,
        [String(a.domain), lower(a.vendorId)],
      );
      break;

    case "DomainRemoved":
      await q(`DELETE FROM vendor_domains WHERE domain = $1 AND vendor_id = $2`, [
        String(a.domain),
        lower(a.vendorId),
      ]);
      break;

    case "WalletAdded":
      await q(
        `INSERT INTO vendor_wallets (wallet, vendor_id) VALUES ($1,$2)
         ON CONFLICT (wallet) DO UPDATE SET vendor_id = EXCLUDED.vendor_id`,
        [lower(a.wallet), lower(a.vendorId)],
      );
      break;

    case "WalletRemoved":
      await q(`DELETE FROM vendor_wallets WHERE wallet = $1 AND vendor_id = $2`, [
        lower(a.wallet),
        lower(a.vendorId),
      ]);
      break;

    case "X402EndpointUpdated":
      await q(`UPDATE vendors SET x402_endpoint = $2, updated_at = $3 WHERE vendor_id = $1`, [
        lower(a.vendorId),
        String(a.endpoint),
        ev.blockTime,
      ]);
      break;

    case "MetadataUpdated":
      await q(
        `UPDATE vendors SET metadata_hash = $2, metadata_uri = $3, metadata_version = $4, updated_at = $5
         WHERE vendor_id = $1`,
        [lower(a.vendorId), lower(a.metadataHash), String(a.metadataURI), Number(a.version), ev.blockTime],
      );
      break;

    case "ContractMetadataUpdated":
      await q(
        `UPDATE vendors SET contract_metadata_hash = $2, contract_metadata_version = $3, updated_at = $4
         WHERE vendor_id = $1`,
        [lower(a.vendorId), lower(a.contractMetadataHash), Number(a.version), ev.blockTime],
      );
      break;

    case "Attested":
      await q(
        `INSERT INTO attestations (attestation_id, vendor_id, att_type, evidence_hash, issued_at, expires_at, attester, block_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (attestation_id) DO NOTHING`,
        [
          lower(a.attestationId),
          lower(a.vendorId),
          Number(a.attType),
          lower(a.evidenceHash),
          tsFromUnix(a.issuedAt),
          tsFromUnix(a.expiresAt),
          lower(a.attester),
          ev.blockNumber.toString(),
        ],
      );
      break;

    case "AttestationRevoked":
      await q(`UPDATE attestations SET revoked = TRUE, revoke_reason = $2 WHERE attestation_id = $1`, [
        lower(a.attestationId),
        String(a.reason ?? ""),
      ]);
      break;

    case "AttesterBanned":
      await q(
        `INSERT INTO attester_bans (attester, issued_at_cutoff) VALUES ($1,$2)
         ON CONFLICT (attester) DO UPDATE SET issued_at_cutoff = EXCLUDED.issued_at_cutoff`,
        [lower(a.attester), tsFromUnix(a.issuedAtCutoff)],
      );
      break;

    default:
      // VendorOwnershipTransferStarted, role events, upgrade events: recorded in
      // chain_events (audit trail) but not projected.
      break;
  }
}

/** Rebuild all derived tables from the stored event log (reorg recovery / disaster recovery). */
export async function rebuildDerivedState(db: Db): Promise<void> {
  await db.tx(async (q) => {
    await q(`DELETE FROM attestations`);
    await q(`DELETE FROM attester_bans`);
    await q(`DELETE FROM vendor_domains`);
    await q(`DELETE FROM vendor_wallets`);
    await q(`DELETE FROM vendors`);
    const events = await q<{
      tx_hash: string;
      log_index: number;
      block_number: string;
      block_hash: string;
      block_time: Date | string;
      contract: string;
      event_name: string;
      args: unknown;
    }>(`SELECT * FROM chain_events ORDER BY block_number ASC, log_index ASC`);
    for (const row of events.rows) {
      await applyEvent(q, {
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash,
        blockTime: new Date(row.block_time as string),
        contract: row.contract as DecodedEvent["contract"],
        eventName: row.event_name,
        args: (typeof row.args === "string" ? JSON.parse(row.args) : row.args) as Record<string, unknown>,
      });
    }
  });
}
