import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  SNAPSHOT_COLUMNS,
  SNAPSHOT_FILES,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotManifest,
  type SnapshotTable,
} from "../../src/data/schema.js";

type Rows = Record<SnapshotTable, Record<string, unknown>[]>;

const sqlValue = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `[${v.map(sqlValue).join(", ")}]`;
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  return String(v);
};

export const FIXTURE_ROWS: Rows = {
  technologies: [
    { tech_id: 1, name: "Shopify", slug: "shopify", categories: ["Ecommerce"], vendor_domain: "shopify.com", aliases: ["Shopify Plus"], note: null, site_count: 3 },
    { tech_id: 2, name: "WordPress", slug: "wordpress", categories: ["CMS", "Blogs"], vendor_domain: "wordpress.org", aliases: [], note: null, site_count: 2 },
    { tech_id: 3, name: "Doppler", slug: "doppler", categories: ["Email marketing"], vendor_domain: "fromdoppler.com", aliases: [], note: "Doppler is fromdoppler.com email marketing, not the secrets manager.", site_count: 1 },
    { tech_id: 4, name: "Klaviyo", slug: "klaviyo", categories: ["Email marketing"], vendor_domain: "klaviyo.com", aliases: [], note: null, site_count: 2 },
    { tech_id: 5, name: "Shopify Pay", slug: "shopify-pay", categories: ["Payment processors"], vendor_domain: "shopify.com", aliases: [], note: null, site_count: 1 },
  ],
  sites: [
    { site_id: 1, domain: "shop-a.com", root_url: "https://shop-a.com/", rank_bucket: 10000, tld: "com", on_mobile: true, on_desktop: true, lcp_p75_mobile: 2100, inp_p75_mobile: 150, cls_p75_mobile: 0.05, lcp_p75_desktop: 1800, inp_p75_desktop: 90, cls_p75_desktop: 0.02, last_crawl_date: "2026-10-01", source: "httparchive" },
    { site_id: 2, domain: "blog-b.org", root_url: "https://blog-b.org/", rank_bucket: 1000000, tld: "org", on_mobile: true, on_desktop: false, lcp_p75_mobile: 4100, inp_p75_mobile: 320, cls_p75_mobile: 0.3, lcp_p75_desktop: null, inp_p75_desktop: null, cls_p75_desktop: null, last_crawl_date: "2026-10-01", source: "httparchive" },
    { site_id: 3, domain: "live-c.io", root_url: "https://live-c.io/", rank_bucket: null, tld: "io", on_mobile: true, on_desktop: true, lcp_p75_mobile: null, inp_p75_mobile: null, cls_p75_mobile: null, lcp_p75_desktop: null, inp_p75_desktop: null, cls_p75_desktop: null, last_crawl_date: "2026-11-10", source: "live_crawl" },
  ],
  site_tech: [
    { site_id: 1, tech_id: 1, version: null, confidence: 1, on_mobile: true, on_desktop: true, first_seen: "2026-10-01", last_seen: "2026-10-01", source: "httparchive" },
    { site_id: 1, tech_id: 4, version: null, confidence: 1, on_mobile: true, on_desktop: true, first_seen: "2026-10-01", last_seen: "2026-10-01", source: "httparchive" },
    { site_id: 2, tech_id: 2, version: "6.8.1", confidence: 1, on_mobile: true, on_desktop: false, first_seen: "2026-10-01", last_seen: "2026-10-01", source: "httparchive" },
    { site_id: 3, tech_id: 1, version: null, confidence: 0.9, on_mobile: true, on_desktop: true, first_seen: "2026-11-10", last_seen: "2026-11-10", source: "live_crawl" },
  ],
};

/** Writes a tiny snapshot (the real schema, a handful of rows) to a temp dir. */
export async function buildFixtureSnapshot(rows: Rows = FIXTURE_ROWS): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wsu-snapshot-"));
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const files: Record<SnapshotTable, string> = {
    technologies: SNAPSHOT_FILES.technologies,
    sites: SNAPSHOT_FILES.sites,
    site_tech: SNAPSHOT_FILES.siteTech,
  };
  for (const table of Object.keys(SNAPSHOT_COLUMNS) as SnapshotTable[]) {
    const cols = Object.entries(SNAPSHOT_COLUMNS[table]);
    await conn.run(`CREATE TABLE ${table} (${cols.map(([c, t]) => `${c} ${t}`).join(", ")})`);
    for (const row of rows[table]) {
      await conn.run(`INSERT INTO ${table} VALUES (${cols.map(([c]) => sqlValue(row[c])).join(", ")})`);
    }
    await conn.run(`COPY ${table} TO '${join(dir, files[table])}' (FORMAT parquet)`);
  }
  conn.closeSync();
  instance.closeSync();

  const manifest: SnapshotManifest = {
    format_version: SNAPSHOT_FORMAT_VERSION,
    crawl_date: "2026-10-01",
    crux_date: "2026-09-01",
    built_at: "2026-11-02T00:00:00.000Z",
    counts: { sites: rows.sites.length, technologies: rows.technologies.length, site_tech: rows.site_tech.length },
  };
  await writeFile(join(dir, SNAPSHOT_FILES.manifest), JSON.stringify(manifest));
  return dir;
}
