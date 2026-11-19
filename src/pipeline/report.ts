import { join } from "node:path";
import type { Config } from "../config.js";
import { CWV_GOOD } from "../data/schema.js";
import { Snapshot } from "../data/snapshot.js";
import { log } from "../log.js";
import { downloadSnapshot, r2Client, readCurrent } from "../storage/r2.js";

/**
 * Figures for site copy ("companies using X" pages), read from the published
 * snapshot so they match what the API answers. No BigQuery, so it costs nothing.
 */
export interface TechnologyReport {
  term: string;
  name: string;
  slug: string;
  categories: string[];
  sites: number;
  share_of_all_sites: number;
  mobile_sites: number;
  by_rank_bucket: { rank_bucket: number | null; sites: number }[];
  /** Ten domains from the most popular bucket the technology appears in. */
  examples: { rank_bucket: number | null; domains: string[] };
  /** Mobile p75s, among sites with all three mobile metrics. */
  cwv_mobile: { sites_with_data: number; all_three_pass: number; pass_rate: number | null };
  used_alongside: { name: string; sites: number; share: number }[];
  top_tlds: { tld: string; sites: number }[];
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const num = (v: unknown) => Number(v ?? 0);

/** Every technology matching a term (exact slug, or name containing it), most used first, five at most. */
export async function technologyReports(snapshot: Snapshot, term: string): Promise<TechnologyReport[]> {
  const total = snapshot.manifest.counts.sites;
  const techs = await snapshot.query<{ tech_id: number; name: string; slug: string; categories: string[] }>(
    `SELECT tech_id, name, slug, categories FROM technologies
     WHERE slug = lower($1) OR contains(lower(name), lower($1))
     ORDER BY slug = lower($1) DESC, site_count DESC LIMIT 5`,
    [term],
  );
  const out: TechnologyReport[] = [];
  for (const t of techs) {
    const id = [t.tech_id];
    const using = `SELECT s.* FROM sites s JOIN site_tech st ON st.site_id = s.site_id WHERE st.tech_id = $1`;
    const [counts] = await snapshot.query<{ sites: unknown; mobile: unknown }>(
      `SELECT count(*) AS sites, count(*) FILTER (WHERE on_mobile) AS mobile FROM site_tech WHERE tech_id = $1`,
      id,
    );
    const buckets = await snapshot.query<{ rank_bucket: number | null; sites: unknown }>(
      `SELECT rank_bucket, count(*) AS sites FROM (${using}) GROUP BY rank_bucket ORDER BY rank_bucket NULLS LAST`,
      id,
    );
    const topBucket = buckets[0]?.rank_bucket ?? null;
    const examples = await snapshot.query<{ domain: string }>(
      `SELECT domain FROM (${using}) WHERE rank_bucket IS NOT DISTINCT FROM $2 ORDER BY domain LIMIT 10`,
      [t.tech_id, topBucket],
    );
    const [cwv] = await snapshot.query<{ with_data: unknown; pass: unknown }>(
      `SELECT count(*) AS with_data,
              count(*) FILTER (WHERE lcp_p75_mobile <= $2 AND inp_p75_mobile <= $3 AND cls_p75_mobile <= $4) AS pass
       FROM (${using}) WHERE lcp_p75_mobile IS NOT NULL AND inp_p75_mobile IS NOT NULL AND cls_p75_mobile IS NOT NULL`,
      [t.tech_id, CWV_GOOD.lcp, CWV_GOOD.inp, CWV_GOOD.cls],
    );
    const alongside = await snapshot.query<{ name: string; sites: unknown }>(
      `SELECT o.name, count(*) AS sites
       FROM site_tech st JOIN site_tech x ON x.site_id = st.site_id AND x.tech_id <> st.tech_id
       JOIN technologies o ON o.tech_id = x.tech_id
       WHERE st.tech_id = $1 GROUP BY o.name ORDER BY sites DESC, o.name LIMIT 5`,
      id,
    );
    const tlds = await snapshot.query<{ tld: string; sites: unknown }>(
      `SELECT tld, count(*) AS sites FROM (${using}) GROUP BY tld ORDER BY sites DESC, tld LIMIT 5`,
      id,
    );
    const sites = num(counts?.sites);
    const withData = num(cwv?.with_data);
    out.push({
      term,
      name: t.name,
      slug: t.slug,
      categories: t.categories,
      sites,
      share_of_all_sites: total ? round(sites / total) : 0,
      mobile_sites: num(counts?.mobile),
      by_rank_bucket: buckets.map((b) => ({ rank_bucket: b.rank_bucket, sites: num(b.sites) })),
      examples: { rank_bucket: topBucket, domains: examples.map((e) => e.domain) },
      cwv_mobile: { sites_with_data: withData, all_three_pass: num(cwv?.pass), pass_rate: withData ? round(num(cwv?.pass) / withData) : null },
      used_alongside: alongside.map((a) => ({ name: a.name, sites: num(a.sites), share: sites ? round(num(a.sites) / sites) : 0 })),
      top_tlds: tlds.map((r) => ({ tld: r.tld, sites: num(r.sites) })),
    });
  }
  return out;
}

/** The report cron mode: fetch the current snapshot from R2 and log one report per technology. */
export async function runReport(config: Config): Promise<void> {
  const s3 = r2Client(config);
  const current = await readCurrent(s3, config.R2_BUCKET);
  if (!current) throw new Error("No snapshot is published to R2 yet.");
  const dir = join(config.PIPELINE_WORK_DIR, "report", current.crawl_date);
  await downloadSnapshot(s3, config.R2_BUCKET, current, dir);
  const snapshot = await Snapshot.open(dir, { serveHttpArchive: config.SERVE_HTTPARCHIVE, memoryLimit: config.PIPELINE_MEMORY_LIMIT });
  try {
    for (const term of config.REPORT_TECHNOLOGIES.split(",").map((t) => t.trim()).filter(Boolean)) {
      const reports = await technologyReports(snapshot, term);
      if (reports.length === 0) log.warn({ term }, "PIPELINE REPORT: no technology matches");
      for (const report of reports) log.info({ crawl_date: current.crawl_date, report }, "PIPELINE REPORT");
    }
  } finally {
    snapshot.close();
  }
}
