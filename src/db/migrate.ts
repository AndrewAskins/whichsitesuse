import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../config.js";
import { log } from "../log.js";

/**
 * Applies src/db/migrations/*.sql in name order, each once, in its own
 * transaction. An advisory lock keeps two deploys from migrating at once.
 */
export async function migrate(databaseUrl: string, dir = defaultDir()): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: sslFor(databaseUrl) });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        log.info({ file }, "migration applied");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    await client.end();
  }
  return applied;
}

/** Render's internal URLs don't use TLS; its external URLs require it. */
export function sslFor(url: string): pg.ClientConfig["ssl"] {
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || !host.includes(".");
  return local ? false : { rejectUnauthorized: false };
}

function defaultDir(): string {
  // Migrations ship as .sql next to the compiled file (copied by the build) or the source file.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = loadConfig();
  if (!DATABASE_URL) {
    log.warn("DATABASE_URL is not set; skipping migrations");
  } else {
    migrate(DATABASE_URL)
      .then((applied) => log.info({ applied }, "migrations up to date"))
      .catch((err) => {
        log.error({ err }, "migrations failed");
        process.exit(1);
      });
  }
}
