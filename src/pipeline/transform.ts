import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { log } from "../log.js";
import {
  SNAPSHOT_FILES,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotManifest,
} from "../data/schema.js";

/** One row of technology_overrides (src/db/migrations/0003), as the pipeline applies it. */
export interface TechnologyOverride {
  source_name: string;
  display_name: string | null;
  vendor_domain: string | null;
  categories: string[] | null;
  aliases: string[];
  note: string | null;
  merge_into: string | null;
  hidden: boolean;
}

export interface BuildOptions {
  /** Glob of the raw extract's Parquet files (extract.sql's columns). */
  rawGlob: string;
  outDir: string;
  crawlDate: string;
  cruxDate: string | null;
  overrides?: TechnologyOverride[];
  /** Last month's snapshot directory, to carry first_seen forward. */
  previousDir?: string | null;
  /** DuckDB memory cap, e.g. "1GB"; DuckDB spills to tempDir beyond it. */
  memoryLimit?: string;
  tempDir?: string;
  /** DuckDB worker threads. Fewer threads hold fewer buffers at once. */
  threads?: number;
  /** Slices for the per-site aggregate, the site_tech join and its sort; defaults to what the memory limit fits. */
  partitions?: number;
  /** Called once the raw extract has been read in full, so the caller can delete it to free disk. */
  onRawConsumed?: () => Promise<void>;
}

const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const strList = (xs: string[] | null) => (xs ? `[${xs.map(lit).join(", ")}]::VARCHAR[]` : "NULL::VARCHAR[]");

// Second-level suffixes common enough to matter for a TLD filter. Not a full public suffix list.
const TWO_PART_TLDS = ["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "com.mx", "co.in", "co.za", "com.ar", "com.tr", "com.cn", "com.sg"];

/**
 * Turns BigQuery's raw extract into the snapshot the query service reads:
 * a cleaned technology catalog (our overrides applied), one row per site,
 * and site_tech sorted by technology so reverse searches read few row groups.
 */
export async function buildSnapshot(opts: BuildOptions): Promise<SnapshotManifest> {
  await mkdir(opts.outDir, { recursive: true });
  const tempDir = opts.tempDir ?? join(opts.outDir, ".tmp");
  await mkdir(tempDir, { recursive: true });
  // A database file on disk, not :memory:, so the 257M-row working tables live on
  // disk and only DuckDB's buffer pool (memory_limit) sits in RAM.
  const instance = await DuckDBInstance.create(join(tempDir, "build.duckdb"), {
    memory_limit: opts.memoryLimit ?? "1GB",
    temp_directory: tempDir,
    preserve_insertion_order: "false",
    ...(opts.threads ? { threads: String(opts.threads) } : {}),
  });
  const db = await instance.connect();
  try {
    await db.run(`CREATE VIEW raw AS SELECT * FROM read_parquet(${lit(opts.rawGlob)})`);
    const rawRows = Number(
      (await (await db.runAndReadAll("SELECT count(*)::BIGINT AS n FROM raw")).getRowObjectsJson())[0]?.n ?? 0,
    );
    const partitions = opts.partitions ?? slicesFor(rawRows, opts.memoryLimit ?? "1GB");
    log.info({ raw_rows: rawRows, partitions }, "snapshot build starting");
    await loadOverrides(db, opts.overrides ?? []);
    const crawl = `DATE ${lit(opts.crawlDate)}`;

    // Technology catalog: HTTP Archive names, folded and renamed by our overrides.
    await db.run(`
      CREATE TABLE tech_src AS
      SELECT technology AS source_name, any_value(categories) AS categories
      FROM raw WHERE technology IS NOT NULL GROUP BY technology`);
    await db.run(`
      CREATE TABLE tech_map AS
      WITH canon AS (
        SELECT t.source_name, t.categories, COALESCE(o.merge_into, t.source_name) AS canonical
        FROM tech_src t LEFT JOIN ov o ON o.source_name = t.source_name
        WHERE NOT COALESCE(o.hidden, false)
      )
      SELECT c.source_name, c.categories, c.canonical,
             COALESCE(oc.display_name, c.canonical) AS name
      FROM canon c LEFT JOIN ov oc ON oc.source_name = c.canonical
      WHERE NOT COALESCE(oc.hidden, false)`);
    await db.run(`
      CREATE TABLE technologies AS
      WITH grouped AS (
        SELECT m.name, any_value(m.canonical) AS canonical,
               list_distinct(flatten(list(m.categories))) AS src_categories
        FROM tech_map m GROUP BY m.name
      ),
      named AS (
        SELECT g.name,
               trim(regexp_replace(lower(g.name), '[^a-z0-9]+', '-', 'g'), '-') AS base_slug,
               COALESCE(o.categories, g.src_categories) AS categories,
               o.vendor_domain, COALESCE(o.aliases, []::VARCHAR[]) AS aliases, o.note
        FROM grouped g LEFT JOIN ov o ON o.source_name = g.canonical
      ),
      numbered AS (
        SELECT *, row_number() OVER (ORDER BY name)::INTEGER AS tech_id,
               count(*) OVER (PARTITION BY base_slug) AS slug_uses
        FROM named
      )
      SELECT tech_id, name,
             CASE WHEN slug_uses > 1 OR base_slug = '' THEN base_slug || '-' || tech_id ELSE base_slug END AS slug,
             categories, vendor_domain, aliases, note, 0::INTEGER AS site_count
      FROM numbered`);

    // Sites: the raw rows repeat each site's columns once per technology.
    const tldCase = `CASE ${TWO_PART_TLDS.map((t) => `WHEN suffix(domain, ${lit("." + t)}) THEN ${lit(t)}`).join(" ")} ELSE regexp_extract(domain, '[^.]+$') END`;
    // Per-site columns repeat on every raw row. Aggregate them a slice of domains
    // at a time so the hash table fits in memory instead of spilling gigabytes.
    await db.run(`
      CREATE TABLE sites_agg (domain VARCHAR, root_url VARCHAR, rank_bucket INTEGER, on_mobile BOOLEAN, on_desktop BOOLEAN,
        lcp_p75_mobile DOUBLE, inp_p75_mobile DOUBLE, cls_p75_mobile DOUBLE,
        lcp_p75_desktop DOUBLE, inp_p75_desktop DOUBLE, cls_p75_desktop DOUBLE)`);
    for (let part = 0; part < partitions; part++) {
      await db.run(`
        INSERT INTO sites_agg
        SELECT domain, any_value(root_url), min(rank_bucket)::INTEGER, bool_or(on_mobile), bool_or(on_desktop),
               any_value(lcp_p75_mobile)::DOUBLE, any_value(inp_p75_mobile)::DOUBLE, any_value(cls_p75_mobile)::DOUBLE,
               any_value(lcp_p75_desktop)::DOUBLE, any_value(inp_p75_desktop)::DOUBLE, any_value(cls_p75_desktop)::DOUBLE
        FROM raw WHERE hash(domain) % ${partitions} = ${part} GROUP BY domain`);
    }
    await db.run(`
      CREATE TABLE sites AS
      SELECT row_number() OVER (ORDER BY rank_bucket NULLS LAST, domain)::INTEGER AS site_id,
             domain, root_url, rank_bucket, ${tldCase} AS tld, on_mobile, on_desktop,
             lcp_p75_mobile, inp_p75_mobile, cls_p75_mobile, lcp_p75_desktop, inp_p75_desktop, cls_p75_desktop,
             ${crawl} AS last_crawl_date, 'httparchive' AS source
      FROM sites_agg`);
    await db.run("DROP TABLE sites_agg");
    log.info({ step: "sites built" }, "snapshot build progress");

    // first_seen carries forward from last month by (domain, technology name).
    if (opts.previousDir) {
      const prev = (f: string) => lit(join(opts.previousDir!, f));
      await db.run(`
        CREATE TABLE prev_seen AS
        SELECT s.domain, t.name, min(st.first_seen) AS first_seen
        FROM read_parquet(${prev(SNAPSHOT_FILES.siteTech)}) st
        JOIN read_parquet(${prev(SNAPSHOT_FILES.sites)}) s USING (site_id)
        JOIN read_parquet(${prev(SNAPSHOT_FILES.technologies)}) t USING (tech_id)
        GROUP BY ALL`);
    } else {
      await db.run(`CREATE TABLE prev_seen (domain VARCHAR, name VARCHAR, first_seen DATE)`);
    }

    // The extract already has one row per (domain, technology), so only technologies
    // that our overrides fold together need grouping. Grouping all 257M rows spills
    // gigabytes; this groups only the folded ones.
    await db.run(`
      -- extract.sql groups by (domain, technology), so unfolded rows are already unique.
      CREATE TABLE tech_ids AS
      SELECT m.source_name, t.tech_id, t.name,
             count(*) OVER (PARTITION BY t.tech_id) > 1 AS folded
      FROM tech_map m JOIN technologies t ON t.name = m.name`);
    const anyFolded = Boolean(
      (await (await db.runAndReadAll("SELECT bool_or(folded) AS f FROM tech_ids")).getRowObjectsJson())[0]?.f,
    );
    const siteTechSelect = (folded: boolean, part: number) => `
      SELECT s.site_id, i.tech_id, ${folded ? "max(r.version)" : "r.version"} AS version, 1.0::DOUBLE AS confidence,
             ${folded ? "bool_or(r.tech_on_mobile)" : "r.tech_on_mobile"} AS on_mobile,
             ${folded ? "bool_or(r.tech_on_desktop)" : "r.tech_on_desktop"} AS on_desktop,
             COALESCE(${folded ? "min(p.first_seen)" : "p.first_seen"}, ${crawl}) AS first_seen, ${crawl} AS last_seen,
             'httparchive' AS source
      FROM raw r
      JOIN tech_ids i ON i.source_name = r.technology AND i.folded = ${folded}
      JOIN sites s ON s.domain = r.domain
      LEFT JOIN prev_seen p ON p.domain = r.domain AND p.name = i.name
      WHERE hash(r.domain) % ${partitions} = ${part}
      ${folded ? "GROUP BY s.site_id, i.tech_id" : ""}`;
    // Same slices as the sites aggregate, so each join and group stays in memory.
    await db.run(`CREATE TABLE site_tech AS ${siteTechSelect(false, 0)}`);
    for (let part = 0; part < partitions; part++) {
      if (part > 0) await db.run(`INSERT INTO site_tech ${siteTechSelect(false, part)}`);
      if (anyFolded) await db.run(`INSERT INTO site_tech ${siteTechSelect(true, part)}`);
    }
    await db.run("DROP TABLE prev_seen; DROP TABLE tech_src; DROP TABLE tech_ids");
    log.info({ step: "site_tech built" }, "snapshot build progress");
    if (opts.onRawConsumed) await opts.onRawConsumed();

    // Reverse searches read site_tech by technology, so it's written sorted by
    // (tech_id, site_id). Sorting 257M rows at once spills about as much as the
    // table itself; sorting one range of technologies at a time stays in memory.
    const techRows = (await (await db.runAndReadAll(
      "SELECT tech_id, count(*)::BIGINT AS n FROM site_tech GROUP BY tech_id ORDER BY tech_id",
    )).getRowObjectsJson()) as { tech_id: number; n: string }[];
    const total = techRows.reduce((sum, r) => sum + Number(r.n), 0);
    const ranges: [number, number][] = [];
    let from = techRows[0]?.tech_id ?? 0;
    let acc = 0;
    for (const r of techRows) {
      acc += Number(r.n);
      if (acc >= total / partitions) {
        ranges.push([from, r.tech_id]);
        from = r.tech_id + 1;
        acc = 0;
      }
    }
    if (acc > 0) ranges.push([from, techRows.at(-1)!.tech_id]);
    await db.run("SET preserve_insertion_order = true");
    await db.run("CREATE TABLE site_tech_sorted AS SELECT * FROM site_tech LIMIT 0");
    for (const [lo, hi] of ranges) {
      await db.run(
        `INSERT INTO site_tech_sorted SELECT * FROM site_tech WHERE tech_id BETWEEN ${lo} AND ${hi} ORDER BY tech_id, site_id`,
      );
    }
    await db.run("DROP TABLE site_tech");
    await db.run("ALTER TABLE site_tech_sorted RENAME TO site_tech");
    log.info({ step: "site_tech sorted", ranges: ranges.length }, "snapshot build progress");
    await db.run(`
      UPDATE technologies SET site_count = c.n
      FROM (SELECT tech_id, count(*)::INTEGER AS n FROM site_tech GROUP BY tech_id) c
      WHERE technologies.tech_id = c.tech_id`);

    log.info({ step: "tables built" }, "snapshot build progress");
    const out = (f: string) => lit(join(opts.outDir, f));
    const parquet = "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)";
    await db.run(`COPY (SELECT * FROM technologies ORDER BY tech_id) TO ${out(SNAPSHOT_FILES.technologies)} ${parquet}`);
    await db.run(`COPY (SELECT * FROM sites ORDER BY site_id) TO ${out(SNAPSHOT_FILES.sites)} ${parquet}`);
    // Already in (tech_id, site_id) order, and preserve_insertion_order keeps it that way.
    await db.run(`COPY site_tech TO ${out(SNAPSHOT_FILES.siteTech)} ${parquet}`);
    log.info({ step: "parquet written" }, "snapshot build progress");

    const count = async (table: string) =>
      Number((await (await db.runAndReadAll(`SELECT count(*)::BIGINT AS n FROM ${table}`)).getRowObjectsJson())[0]?.n);
    const manifest: SnapshotManifest = {
      format_version: SNAPSHOT_FORMAT_VERSION,
      crawl_date: opts.crawlDate,
      crux_date: opts.cruxDate,
      built_at: new Date().toISOString(),
      counts: { sites: await count("sites"), technologies: await count("technologies"), site_tech: await count("site_tech") },
    };
    await writeFile(join(opts.outDir, SNAPSHOT_FILES.manifest), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}

/** Raw rows one slice may hold in memory: about 5,000 per MB of DuckDB memory, measured on a synthetic extract. */
export const ROWS_PER_MB = 5_000;

/** How many slices keep each aggregate, join and sort inside the memory limit. */
export function slicesFor(rawRows: number, memoryLimit: string): number {
  const m = /^\s*([\d.]+)\s*(KB|MB|GB|KiB|MiB|GiB)?\s*$/i.exec(memoryLimit);
  const unit = (m?.[2] ?? "MB").toUpperCase().replace("I", "");
  const mb = m ? Number(m[1]) * (unit === "GB" ? 1024 : unit === "KB" ? 1 / 1024 : 1) : 1024;
  return Math.max(1, Math.ceil(rawRows / (mb * ROWS_PER_MB)));
}

async function loadOverrides(db: DuckDBConnection, overrides: TechnologyOverride[]) {
  await db.run(`
    CREATE TABLE ov (source_name VARCHAR, display_name VARCHAR, vendor_domain VARCHAR, categories VARCHAR[],
                     aliases VARCHAR[], note VARCHAR, merge_into VARCHAR, hidden BOOLEAN)`);
  for (const o of overrides) {
    const v = (x: string | null) => (x === null ? "NULL" : lit(x));
    await db.run(
      `INSERT INTO ov VALUES (${lit(o.source_name)}, ${v(o.display_name)}, ${v(o.vendor_domain)}, ${strList(o.categories)}, ${strList(o.aliases)}, ${v(o.note)}, ${v(o.merge_into)}, ${o.hidden})`,
    );
  }
}
