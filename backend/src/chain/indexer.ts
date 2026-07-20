import {createPublicClient, http, parseEventLogs, type Address, type PublicClient} from "viem";
import {vendorRegistryAbi, attestationRegistryAbi} from "@actp/core";
import type {AppConfig} from "../config.js";
import type {Db} from "../db/client.js";
import {storeAndApplyEvent, rebuildDerivedState, type DecodedEvent} from "./applier.js";

const CHECKPOINT_ID = "registry";
const MAX_BLOCK_RANGE = 2000n;

export interface Indexer {
  /** Run a single catch-up pass. Returns the number of events applied. */
  runOnce(): Promise<number>;
  /** Start the poll loop. */
  start(): void;
  stop(): Promise<void>;
}

export function createIndexer(opts: {
  db: Db;
  config: AppConfig;
  client?: PublicClient;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Indexer {
  const {db, config} = opts;
  const log = opts.log ?? (() => {});
  // cacheTime: 0 — viem caches getBlockNumber by default (~4s), which makes the indexer
  // read a stale chain head and lag behind freshly-mined blocks. The indexer must always
  // see the true head.
  const client =
    opts.client ?? (createPublicClient({transport: http(config.RPC_URL), cacheTime: 0}) as PublicClient);

  const registryAddr = config.VENDOR_REGISTRY_ADDRESS as Address | undefined;
  const attestAddr = config.ATTESTATION_REGISTRY_ADDRESS as Address | undefined;
  if (!registryAddr || !attestAddr) {
    throw new Error("VENDOR_REGISTRY_ADDRESS and ATTESTATION_REGISTRY_ADDRESS must be configured");
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  async function getCheckpoint(): Promise<{block: bigint; hash: string} | null> {
    const res = await db.query<{last_block: string; last_block_hash: string}>(
      `SELECT last_block, last_block_hash FROM indexer_state WHERE id = $1`,
      [CHECKPOINT_ID],
    );
    const row = res.rows[0];
    return row ? {block: BigInt(row.last_block), hash: row.last_block_hash} : null;
  }

  async function setCheckpoint(q: Db["query"], block: bigint, hash: string): Promise<void> {
    await q(
      `INSERT INTO indexer_state (id, last_block, last_block_hash, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO UPDATE SET last_block = $2, last_block_hash = $3, updated_at = now()`,
      [CHECKPOINT_ID, block.toString(), hash],
    );
  }

  /** Detect a reorg at the checkpoint; if found, rewind and rebuild derived state. */
  async function ensureCheckpointCanonical(): Promise<bigint> {
    const cp = await getCheckpoint();
    if (!cp) return BigInt(Math.max(config.DEPLOY_BLOCK - 1, 0));

    const onChain = await client.getBlock({blockNumber: cp.block}).catch(() => null);
    if (onChain && onChain.hash?.toLowerCase() === cp.hash.toLowerCase()) return cp.block;

    const rewindTo =
      cp.block > BigInt(config.INDEXER_REORG_DEPTH)
        ? cp.block - BigInt(config.INDEXER_REORG_DEPTH)
        : BigInt(Math.max(config.DEPLOY_BLOCK - 1, 0));
    log("reorg detected at checkpoint; rewinding", {from: cp.block.toString(), to: rewindTo.toString()});

    await db.tx(async (q) => {
      await q(`DELETE FROM chain_events WHERE block_number > $1`, [rewindTo.toString()]);
      const blk = rewindTo > 0n ? await client.getBlock({blockNumber: rewindTo}) : null;
      await setCheckpoint(q, rewindTo, blk?.hash ?? "0x");
    });
    await rebuildDerivedState(db);
    return rewindTo;
  }

  async function runOnce(): Promise<number> {
    const fromExclusive = await ensureCheckpointCanonical();
    const head = await client.getBlockNumber();
    const target = head - BigInt(config.INDEXER_CONFIRMATIONS);
    if (target <= fromExclusive) return 0;

    let applied = 0;
    let cursor = fromExclusive;
    while (cursor < target && !stopped) {
      const from = cursor + 1n;
      const to = target - from > MAX_BLOCK_RANGE ? from + MAX_BLOCK_RANGE : target;

      const logs = await client.getLogs({address: [registryAddr!, attestAddr!], fromBlock: from, toBlock: to});
      const events: DecodedEvent[] = [];
      const blockTimes = new Map<bigint, Date>();

      for (const raw of logs) {
        const isRegistry = raw.address.toLowerCase() === registryAddr!.toLowerCase();
        const parsed = parseEventLogs({
          abi: isRegistry ? vendorRegistryAbi : attestationRegistryAbi,
          logs: [raw],
          strict: false,
        })[0];
        if (!parsed || !("eventName" in parsed) || !parsed.eventName) continue;
        if (raw.blockNumber === null || raw.blockHash === null || raw.transactionHash === null) continue;

        let blockTime = blockTimes.get(raw.blockNumber);
        if (!blockTime) {
          const blk = await client.getBlock({blockNumber: raw.blockNumber});
          blockTime = new Date(Number(blk.timestamp) * 1000);
          blockTimes.set(raw.blockNumber, blockTime);
        }

        events.push({
          txHash: raw.transactionHash,
          logIndex: raw.logIndex ?? 0,
          blockNumber: raw.blockNumber,
          blockHash: raw.blockHash,
          blockTime,
          contract: isRegistry ? "VendorRegistry" : "AttestationRegistry",
          eventName: parsed.eventName as string,
          args: (parsed.args ?? {}) as Record<string, unknown>,
        });
      }

      events.sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );

      const toBlock = await client.getBlock({blockNumber: to});
      await db.tx(async (q) => {
        for (const ev of events) {
          await storeAndApplyEvent(q, ev);
        }
        await setCheckpoint(q, to, toBlock.hash ?? "0x");
      });

      applied += events.length;
      cursor = to;
    }
    if (applied > 0) log("indexed", {events: applied, upTo: cursor.toString()});
    return applied;
  }

  return {
    runOnce,
    start() {
      const tick = async () => {
        if (running || stopped) return;
        running = true;
        try {
          await runOnce();
        } catch (err) {
          log("indexer error", {error: String(err)});
        } finally {
          running = false;
        }
      };
      void tick();
      timer = setInterval(tick, config.INDEXER_POLL_MS);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) {
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}
