import type {FastifyInstance} from "fastify";
import {loadConfig, type AppConfig} from "./config.js";
import {createDb, type Db} from "./db/client.js";
import {migrate} from "./db/migrations.js";
import {createIndexer, type Indexer} from "./chain/indexer.js";
import {VendorService} from "./services/vendors.js";
import {MetadataService} from "./services/metadata.js";
import {createIpfsStore} from "./storage/ipfs.js";
import {ContractIntelService} from "./services/contractIntel/service.js";
import {DeterministicExtractor} from "./services/contractIntel/deterministic.js";
import type {TermExtractor} from "./services/contractIntel/extractor.js";
import {RiskEngine} from "./services/risk/engine.js";
import {buildServer, type AppServices} from "./api/server.js";

export interface App {
  config: AppConfig;
  db: Db;
  server: FastifyInstance;
  services: AppServices;
  indexer: Indexer | null;
  close(): Promise<void>;
}

/** Wire the whole backend. `withIndexer: false` runs API-only (tests without a chain). */
export async function buildApp(
  overrides: Partial<AppConfig> = {},
  opts: {withIndexer?: boolean} = {},
): Promise<App> {
  const config = {...loadConfig(), ...overrides};

  const db = await createDb(config.DATABASE_URL);
  await migrate(db);

  let extractor: TermExtractor = new DeterministicExtractor();
  if (config.CONTRACT_EXTRACTOR === "llm") {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error("CONTRACT_EXTRACTOR=llm requires ANTHROPIC_API_KEY");
    }
    const {LlmExtractor} = await import("./services/contractIntel/llm.js");
    extractor = new LlmExtractor({apiKey: config.ANTHROPIC_API_KEY, model: config.EXTRACTOR_MODEL});
  }

  const ipfs = createIpfsStore(config);
  const vendors = new VendorService(db);
  const metadata = new MetadataService(db, ipfs);
  const contractIntel = new ContractIntelService(db, extractor);
  const risk = new RiskEngine(db, vendors, metadata);

  const services: AppServices = {db, vendors, metadata, contractIntel, risk, ipfs};
  const server = buildServer(services, config);

  let indexer: Indexer | null = null;
  if (opts.withIndexer !== false && config.VENDOR_REGISTRY_ADDRESS && config.ATTESTATION_REGISTRY_ADDRESS) {
    indexer = createIndexer({
      db,
      config,
      log: (msg, extra) => server.log.info(extra ?? {}, msg),
    });
  }

  return {
    config,
    db,
    server,
    services,
    indexer,
    async close() {
      await indexer?.stop();
      await server.close();
      await db.close();
    },
  };
}
