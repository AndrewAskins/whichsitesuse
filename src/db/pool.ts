import pg from "pg";
import { sslFor } from "./migrate.js";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, ssl: sslFor(databaseUrl), max: 10 });
}

/** Runs fn in one transaction, rolling back on any error. */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True for a Postgres unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}
