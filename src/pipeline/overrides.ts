import pg from "pg";
import { sslFor } from "../db/migrate.js";
import type { TechnologyOverride } from "./transform.js";

/** Reads our technology cleanup table. No database means no overrides, not an error. */
export async function loadTechnologyOverrides(databaseUrl: string | undefined): Promise<TechnologyOverride[]> {
  if (!databaseUrl) return [];
  const client = new pg.Client({ connectionString: databaseUrl, ssl: sslFor(databaseUrl) });
  await client.connect();
  try {
    const { rows } = await client.query<TechnologyOverride>(
      `SELECT source_name, display_name, vendor_domain, categories, aliases, note, merge_into, hidden
       FROM technology_overrides`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
