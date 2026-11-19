/**
 * The monthly snapshot: three Parquet files plus a manifest, written by the
 * pipeline and read by the query service. This file is the one definition of
 * their columns, so the pipeline, the query service and the tests agree.
 */

export const SNAPSHOT_FORMAT_VERSION = 1;

export const SNAPSHOT_FILES = {
  manifest: "manifest.json",
  technologies: "technologies.parquet",
  sites: "sites.parquet",
  siteTech: "site_tech.parquet",
} as const;

/** Where a row came from. HTTP Archive rows can be switched off with SERVE_HTTPARCHIVE. */
export type Source = "httparchive" | "live_crawl";

export interface SnapshotManifest {
  format_version: number;
  /** HTTP Archive crawl month, YYYY-MM-01. */
  crawl_date: string;
  /** Chrome UX Report month joined for Core Web Vitals, YYYY-MM-01, or null. */
  crux_date: string | null;
  built_at: string;
  counts: { sites: number; technologies: number; site_tech: number };
}

/** DuckDB column types for each table, in file order. */
export const SNAPSHOT_COLUMNS = {
  technologies: {
    tech_id: "INTEGER",
    name: "VARCHAR",
    slug: "VARCHAR",
    categories: "VARCHAR[]",
    vendor_domain: "VARCHAR",
    aliases: "VARCHAR[]",
    note: "VARCHAR",
    site_count: "INTEGER",
  },
  sites: {
    site_id: "INTEGER",
    domain: "VARCHAR",
    root_url: "VARCHAR",
    rank_bucket: "INTEGER",
    tld: "VARCHAR",
    on_mobile: "BOOLEAN",
    on_desktop: "BOOLEAN",
    lcp_p75_mobile: "DOUBLE",
    inp_p75_mobile: "DOUBLE",
    cls_p75_mobile: "DOUBLE",
    lcp_p75_desktop: "DOUBLE",
    inp_p75_desktop: "DOUBLE",
    cls_p75_desktop: "DOUBLE",
    last_crawl_date: "DATE",
    source: "VARCHAR",
  },
  site_tech: {
    site_id: "INTEGER",
    tech_id: "INTEGER",
    version: "VARCHAR",
    confidence: "DOUBLE",
    on_mobile: "BOOLEAN",
    on_desktop: "BOOLEAN",
    first_seen: "DATE",
    last_seen: "DATE",
    source: "VARCHAR",
  },
} as const;

export type SnapshotTable = keyof typeof SNAPSHOT_COLUMNS;

/** Google's "good" thresholds for p75 field data. */
export const CWV_GOOD = { lcp: 2500, inp: 200, cls: 0.1 } as const;

/** HTTP Archive rank buckets (CrUX popularity), smallest first. */
export const RANK_BUCKETS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000] as const;
