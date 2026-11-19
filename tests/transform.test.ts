import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { buildSnapshot, type TechnologyOverride } from "../src/pipeline/transform.js";

// Rows shaped like extract.sql's output: one per (site, technology).
const RAW = `
SELECT * FROM (VALUES
  ('shop-a.com', 'https://shop-a.com/', 10000, true, true, 2100.0, 150.0, 0.05, 1800.0, 90.0, 0.02, 'Shopify', ['Ecommerce'], NULL, true, true),
  ('shop-a.com', 'https://shop-a.com/', 10000, true, true, 2100.0, 150.0, 0.05, 1800.0, 90.0, 0.02, 'Doppler', ['Email'], NULL, true, false),
  ('shop-a.com', 'https://shop-a.com/', 10000, true, true, 2100.0, 150.0, 0.05, 1800.0, 90.0, 0.02, 'Old Tracker', ['Analytics'], NULL, true, true),
  ('blog.example.co.uk', 'https://blog.example.co.uk/', 1000000, true, false, NULL, NULL, NULL, NULL, NULL, NULL, 'WordPress', ['CMS', 'Blogs'], '6.8.1', true, false),
  ('blog.example.co.uk', 'https://blog.example.co.uk/', 1000000, true, false, NULL, NULL, NULL, NULL, NULL, NULL, 'Shopify Plus', ['Ecommerce'], NULL, true, false),
  ('bare.io', 'https://bare.io/', NULL, true, true, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
) AS t(domain, root_url, rank_bucket, on_mobile, on_desktop, lcp_p75_mobile, inp_p75_mobile, cls_p75_mobile,
       lcp_p75_desktop, inp_p75_desktop, cls_p75_desktop, technology, categories, version, tech_on_mobile, tech_on_desktop)`;

const OVERRIDES: TechnologyOverride[] = [
  { source_name: "Shopify Plus", display_name: null, vendor_domain: null, categories: null, aliases: [], note: null, merge_into: "Shopify", hidden: false },
  { source_name: "Shopify", display_name: null, vendor_domain: "shopify.com", categories: null, aliases: ["Shopify Plus"], note: null, merge_into: null, hidden: false },
  { source_name: "Doppler", display_name: "Doppler (email marketing)", vendor_domain: "fromdoppler.com", categories: ["Email marketing"], aliases: [], note: "Doppler is fromdoppler.com email marketing, not the secrets manager.", merge_into: null, hidden: false },
  { source_name: "Old Tracker", display_name: null, vendor_domain: null, categories: null, aliases: [], note: null, merge_into: null, hidden: true },
];

let rawGlob: string;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsu-raw-"));
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(`COPY (${RAW}) TO '${join(dir, "000000000000.parquet")}' (FORMAT parquet)`);
  conn.closeSync();
  instance.closeSync();
  rawGlob = join(dir, "*.parquet");
});

async function build(previousDir?: string, crawlDate = "2026-11-01") {
  const outDir = await mkdtemp(join(tmpdir(), "wsu-out-"));
  const manifest = await buildSnapshot({ rawGlob, outDir, crawlDate, cruxDate: "2026-10-01", overrides: OVERRIDES, previousDir, memoryLimit: "256MB" });
  return { outDir, manifest, snap: await Snapshot.open(outDir, { serveHttpArchive: true }) };
}

describe("buildSnapshot", () => {
  it("writes a manifest with counts and dates", async () => {
    const { manifest, snap } = await build();
    expect(manifest).toMatchObject({ crawl_date: "2026-11-01", crux_date: "2026-10-01", counts: { sites: 3, technologies: 3, site_tech: 4 } });
    snap.close();
  });

  it("applies merges, renames, notes and hides from the overrides", async () => {
    const { snap } = await build();
    const techs = await snap.query<{ name: string; slug: string; vendor_domain: string | null; note: string | null; categories: string[]; site_count: number; aliases: string[] }>(
      "SELECT name, slug, vendor_domain, note, categories, site_count, aliases FROM technologies ORDER BY name",
    );
    expect(techs.map((t) => t.name)).toEqual(["Doppler (email marketing)", "Shopify", "WordPress"]);
    const shopify = techs.find((t) => t.name === "Shopify")!;
    expect(shopify).toMatchObject({ slug: "shopify", vendor_domain: "shopify.com", site_count: 2, aliases: ["Shopify Plus"] });
    const doppler = techs.find((t) => t.slug === "doppler-email-marketing")!;
    expect(doppler.categories).toEqual(["Email marketing"]);
    expect(doppler.note).toMatch(/fromdoppler/);
    snap.close();
  });

  it("keeps sites with no detections and derives TLDs and rank order", async () => {
    const { snap } = await build();
    const sites = await snap.query<{ site_id: number; domain: string; tld: string; rank_bucket: number | null }>(
      "SELECT site_id, domain, tld, rank_bucket FROM sites ORDER BY site_id",
    );
    expect(sites.map((s) => [s.domain, s.tld])).toEqual([
      ["shop-a.com", "com"],
      ["blog.example.co.uk", "co.uk"],
      ["bare.io", "io"],
    ]);
    snap.close();
  });

  it("keeps per-device detection and versions", async () => {
    const { snap } = await build();
    const [row] = await snap.query<{ version: string; on_desktop: boolean }>(
      "SELECT version, st.on_desktop FROM site_tech st JOIN technologies t USING (tech_id) WHERE t.name = 'WordPress'",
    );
    expect(row).toMatchObject({ version: "6.8.1", on_desktop: false });
    snap.close();
  });

  it("carries first_seen forward from last month", async () => {
    const first = await build(undefined, "2026-10-01");
    first.snap.close();
    const second = await build(first.outDir, "2026-11-01");
    const rows = await second.snap.query<{ first_seen: string; last_seen: string }>(
      "SELECT first_seen::VARCHAR AS first_seen, last_seen::VARCHAR AS last_seen FROM site_tech LIMIT 1",
    );
    expect(rows[0]).toEqual({ first_seen: "2026-10-01", last_seen: "2026-11-01" });
    second.snap.close();
  });
});

describe("slicesFor", () => {
  it("sizes slices to the memory limit", async () => {
    const { slicesFor } = await import("../src/pipeline/transform.js");
    expect(slicesFor(257_695_327, "1200MB")).toBe(43);
    expect(slicesFor(257_695_327, "1.2GB")).toBe(42);
    expect(slicesFor(1_000, "1GB")).toBe(1);
  });
});

describe("buildSnapshot in slices", () => {
  it("gives the same snapshot in many slices as in one, sorted by technology", async () => {
    const read = async (partitions: number) => {
      const outDir = await mkdtemp(join(tmpdir(), "wsu-out-"));
      const consumed: string[] = [];
      await buildSnapshot({
        rawGlob, outDir, crawlDate: "2026-11-01", cruxDate: "2026-10-01", overrides: OVERRIDES, memoryLimit: "256MB",
        partitions, onRawConsumed: async () => { consumed.push("raw"); },
      });
      const snap = await Snapshot.open(outDir, { serveHttpArchive: true });
      const rows = await snap.query<{ tech_id: number; site_id: number; on_mobile: boolean }>(
        "SELECT tech_id, site_id, on_mobile FROM read_parquet($1)",
        [join(outDir, "site_tech.parquet")],
      );
      snap.close();
      return { rows, consumed };
    };
    const one = await read(1);
    const many = await read(5);
    expect(many.rows).toEqual(one.rows);
    expect(many.consumed).toEqual(["raw"]);
    const sorted = [...many.rows].sort((a, b) => a.tech_id - b.tech_id || a.site_id - b.site_id);
    expect(many.rows).toEqual(sorted);
  });
});

describe("sites.parquet", () => {
  it("is sorted by domain, so a domain lookup reads one row group", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "wsu-out-"));
    await buildSnapshot({ rawGlob, outDir, crawlDate: "2026-11-01", cruxDate: "2026-10-01", overrides: OVERRIDES, memoryLimit: "256MB" });
    const snap = await Snapshot.open(outDir, { serveHttpArchive: true });
    const rows = await snap.query<{ domain: string }>("SELECT domain FROM read_parquet($1)", [join(outDir, "sites.parquet")]);
    snap.close();
    const domains = rows.map((r) => r.domain);
    expect(domains).toEqual([...domains].sort());
  });
});
