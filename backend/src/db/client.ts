/**
 * Database abstraction: real Postgres in production (DATABASE_URL), embedded PGlite
 * (WASM Postgres, zero external dependencies) for local development and tests.
 * Both speak the same SQL dialect, so services are written once.
 */

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** Serialized transaction helper. */
  tx<T>(fn: (q: Db["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(databaseUrl?: string): Promise<Db> {
  if (databaseUrl && databaseUrl.length > 0) {
    return createPgDb(databaseUrl);
  }
  return createPgliteDb();
}

async function createPgDb(databaseUrl: string): Promise<Db> {
  const {default: pg} = await import("pg");
  const pool = new pg.Pool({connectionString: databaseUrl, max: 10});

  const query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const res = await pool.query(sql, params as never[]);
    return {rows: res.rows as R[], rowCount: res.rowCount ?? 0};
  };

  return {
    query,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const res = await client.query(sql, params as never[]);
          return {rows: res.rows as R[], rowCount: res.rowCount ?? 0};
        };
        const out = await fn(q as Db["query"]);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(): Promise<Db> {
  const {PGlite} = await import("@electric-sql/pglite");
  const lite = new PGlite(); // in-memory

  const query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const res = await lite.query(sql, params as never[]);
    return {rows: res.rows as R[], rowCount: res.affectedRows ?? res.rows.length};
  };

  // PGlite is single-connection; BEGIN/COMMIT serialize naturally. A mutex guards
  // against interleaved async transactions.
  let lock: Promise<unknown> = Promise.resolve();

  return {
    query,
    async tx(fn) {
      const run = async () => {
        await query("BEGIN");
        try {
          const out = await fn(query as Db["query"]);
          await query("COMMIT");
          return out;
        } catch (err) {
          await query("ROLLBACK");
          throw err;
        }
      };
      const next = lock.then(run, run);
      lock = next.catch(() => undefined);
      return next as Promise<ReturnType<typeof fn>>;
    },
    async close() {
      await lite.close();
    },
  };
}
