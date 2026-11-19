import type { Snapshot } from "../data/snapshot.js";
import { CWV_GOOD } from "../data/schema.js";
import { adultListSql, adultSitesSql } from "./adult.js";
import type { CatalogEntry } from "./catalog.js";
import { SEO_RULES, type SeoRules } from "./config.js";

/**
 * The data behind the programmatic pages, built once a month from the snapshot
 * (in the pipeline, where there is memory to spare) and stored next to it on R2
 * as one JSON file. The API only reads this file, so a page view never queries Parquet.
 */
export const SEO_FORMAT_VERSION = 1;

export interface RankRow {
  /** CrUX bucket upper bound (1000 = top 1k), or null when the site has no CrUX rank. */
  rank_bucket: number | null;
  sites: number;
}

export interface CwvCount {
  /** Sites with mobile p75 field data for all three metrics. */
  tested: number;
  /** ...of which LCP, INP and CLS are all within Google's "good" thresholds. */
  good: number;
}

export interface SeoTechnology {
  slug: string;
  name: string;
  categories: string[];
  vendor_domain: string | null;
  note: string | null;
  /** Icon file on HTTP Archive's CDN and its one-line description, when its catalog has them. */
  icon?: string | null;
  description?: string | null;
  sites: number;
  /** Sites in the previous month's dataset, when there was one. */
  previous_sites: number | null;
  by_rank: RankRow[];
  /** Highest-ranked sites running it, best bucket first (stable hash order inside a bucket). */
  top_sites: { domain: string; rank_bucket: number }[];
  /** Estimated from a hash sample of sites; null when the sample is too small. */
  co_used: { slug: string; share: number; base_share: number }[] | null;
  cwv: CwvCount;
  versions: { version: string; sites: number }[];
  tlds: { tld: string; sites: number }[];
}

export interface SeoCategory {
  slug: string;
  name: string;
  /** Distinct sites running any technology in the category (HyperLogLog estimate, within about 2%). */
  sites_estimate: number;
  /** Slugs of its technologies that have pages, most sites first. */
  technologies: string[];
}

export interface SeoDataset {
  format_version: number;
  crawl_date: string;
  crux_date: string | null;
  built_at: string;
  total_sites: number;
  by_rank: RankRow[];
  cwv: CwvCount;
  co_usage_sample_every: number;
  technologies: SeoTechnology[];
  categories: SeoCategory[];
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const cwvTested = (p: string) =>
  `${p}lcp_p75_mobile IS NOT NULL AND ${p}inp_p75_mobile IS NOT NULL AND ${p}cls_p75_mobile IS NOT NULL`;
const cwvGood = (p: string) =>
  `${p}lcp_p75_mobile <= ${CWV_GOOD.lcp} AND ${p}inp_p75_mobile <= ${CWV_GOOD.inp} AND ${p}cls_p75_mobile <= ${CWV_GOOD.cls}`;

type TechRow = Omit<SeoTechnology, "previous_sites" | "by_rank" | "top_sites" | "co_used" | "cwv" | "versions" | "tlds"> & {
  tech_id: number;
};

/**
 * Builds the dataset with a handful of set-based queries (one pass each over site_tech),
 * never a query per technology. All numbers in SQL come from SEO_RULES, not from input.
 */
export async function buildSeoDataset(
  snapshot: Snapshot,
  opts: {
    previous?: SeoDataset | null;
    now?: Date;
    rules?: Partial<SeoRules>;
    catalog?: Map<string, CatalogEntry>;
    /** Domains from the adult blocklist (src/seo/adult.ts), left out of top-sites tables. */
    adultDomains?: readonly string[];
  } = {},
): Promise<SeoDataset> {
  const R: SeoRules = { ...SEO_RULES, ...opts.rules };
  const q = <T>(sql: string) => snapshot.query<T>(sql);

  await q(`
    CREATE OR REPLACE TEMP TABLE seo_tech AS
    SELECT tech_id, name, slug, categories, vendor_domain, note, site_count AS sites
    FROM technologies WHERE site_count >= ${R.minPageSites}`);

  const techs = await q<TechRow>("SELECT * FROM seo_tech ORDER BY sites DESC, slug");

  const overall = await q<RankRow & CwvCount>(`
    SELECT rank_bucket, count(*)::INTEGER AS sites,
      count(*) FILTER (WHERE ${cwvTested("")})::INTEGER AS tested,
      count(*) FILTER (WHERE ${cwvGood("")})::INTEGER AS good
    FROM sites GROUP BY rank_bucket`);

  const perRank = await q<RankRow & CwvCount & { tech_id: number }>(`
    SELECT st.tech_id, s.rank_bucket, count(*)::INTEGER AS sites,
      count(*) FILTER (WHERE ${cwvTested("s.")})::INTEGER AS tested,
      count(*) FILTER (WHERE ${cwvGood("s.")})::INTEGER AS good
    FROM site_tech st JOIN seo_tech t USING (tech_id) JOIN sites s USING (site_id)
    GROUP BY st.tech_id, s.rank_bucket`);

  // Named sites leave out adult sites (src/seo/adult.ts); the counts above still include them.
  // DISTINCT here and in the co-usage sample: a domain listed twice, or a share over 100%, is never right on a page.
  await q(adultListSql(opts.adultDomains ?? []));
  await q(adultSitesSql());
  const topSites = await q<{ tech_id: number; domain: string; rank_bucket: number }>(`
    SELECT tech_id, domain, rank_bucket FROM (
      SELECT DISTINCT st.tech_id, s.domain, s.rank_bucket
      FROM site_tech st JOIN seo_tech t USING (tech_id) JOIN sites s USING (site_id)
      WHERE s.rank_bucket <= ${R.topSitesMaxRank} AND st.site_id NOT IN (SELECT site_id FROM adult_sites))
    QUALIFY row_number() OVER (PARTITION BY tech_id ORDER BY rank_bucket, hash(domain), domain) <= ${R.topSites}`);

  const tlds = await q<{ tech_id: number; tld: string; sites: number }>(`
    SELECT tech_id, tld, sites FROM (
      SELECT st.tech_id, s.tld, count(*)::INTEGER AS sites
      FROM site_tech st JOIN seo_tech t USING (tech_id) JOIN sites s USING (site_id)
      WHERE s.tld IS NOT NULL AND s.tld <> ''
      GROUP BY st.tech_id, s.tld)
    QUALIFY row_number() OVER (PARTITION BY tech_id ORDER BY sites DESC, tld) <= ${R.maxTlds}`);

  const versions = await q<{ tech_id: number; version: string; sites: number }>(`
    SELECT tech_id, version, sites FROM (
      SELECT st.tech_id, regexp_extract(st.version, '^[0-9]+(\\.[0-9]+)?') AS version, count(*)::INTEGER AS sites
      FROM site_tech st JOIN seo_tech t USING (tech_id)
      WHERE st.version IS NOT NULL
      GROUP BY ALL)
    WHERE version <> ''
    QUALIFY row_number() OVER (PARTITION BY tech_id ORDER BY sites DESC, version) <= ${R.maxVersions}`);

  // Co-usage on a 1-in-N hash sample: a full self-join of site_tech would be billions of pairs.
  const every = R.coUsageSampleEvery;
  await q(`
    CREATE OR REPLACE TEMP TABLE seo_sample AS
    SELECT DISTINCT st.site_id, st.tech_id FROM site_tech st JOIN seo_tech t USING (tech_id)
    WHERE hash(st.site_id) % ${every} = 0`);
  const [sampleTotal] = await q<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM sites WHERE hash(site_id) % ${every} = 0`);
  const total = Math.max(sampleTotal?.n ?? 0, 1);
  const pairs = await q<{ a: number; b: number; n: number; na: number; nb: number }>(`
    WITH counts AS (SELECT tech_id, count(*)::INTEGER AS n FROM seo_sample GROUP BY tech_id),
    pairs AS (
      SELECT x.tech_id AS a, y.tech_id AS b, count(*)::INTEGER AS n
      FROM seo_sample x JOIN seo_sample y ON x.site_id = y.site_id AND x.tech_id <> y.tech_id
      GROUP BY ALL)
    SELECT p.a, p.b, p.n, ca.n AS na, cb.n AS nb
    FROM pairs p JOIN counts ca ON ca.tech_id = p.a JOIN counts cb ON cb.tech_id = p.b
    WHERE ca.n >= ${R.coUsageMinSample} AND p.n >= ${R.coUsageMinPair}
      AND (p.n::DOUBLE / ca.n) / (cb.n::DOUBLE / ${total}) >= ${R.coUsageMinLift}
    QUALIFY row_number() OVER (PARTITION BY p.a ORDER BY p.n DESC, p.b) <= ${R.coUsageMax}`);
  const sampled = await q<{ tech_id: number; n: number }>("SELECT tech_id, count(*)::INTEGER AS n FROM seo_sample GROUP BY tech_id");

  const categoryRows = await q<{ name: string; sites_estimate: number }>(`
    SELECT c.name, approx_count_distinct(st.site_id)::INTEGER AS sites_estimate
    FROM site_tech st JOIN (SELECT tech_id, unnest(categories) AS name FROM technologies) c USING (tech_id)
    GROUP BY c.name`);

  await q("DROP TABLE IF EXISTS seo_sample");
  await q("DROP TABLE IF EXISTS seo_tech");

  const byId = new Map(techs.map((t) => [t.tech_id, t]));
  const group = <T extends { tech_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) (m.get(r.tech_id) ?? m.set(r.tech_id, []).get(r.tech_id)!).push(r);
    return m;
  };
  const rankMap = group(perRank);
  const topMap = group(topSites);
  const tldMap = group(tlds);
  const versionMap = group(versions);
  const sampledIds = new Set(sampled.filter((s) => s.n >= R.coUsageMinSample).map((s) => s.tech_id));
  const pairMap = new Map<number, typeof pairs>();
  for (const p of pairs) (pairMap.get(p.a) ?? pairMap.set(p.a, []).get(p.a)!).push(p);
  const previous = new Map((opts.previous?.technologies ?? []).map((t) => [t.slug, t.sites]));

  const sortRank = (a: RankRow, b: RankRow) => (a.rank_bucket ?? Infinity) - (b.rank_bucket ?? Infinity);
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

  // Counts come from the site_tech view, not technologies.site_count, so the kill switch applies to them too.
  const technologies: SeoTechnology[] = techs.flatMap((t) => {
    const ranks = rankMap.get(t.tech_id) ?? [];
    const sites = ranks.reduce((sum, r) => sum + r.sites, 0);
    if (sites < R.minPageSites) return [];
    return [{
      slug: t.slug,
      name: t.name,
      categories: t.categories ?? [],
      vendor_domain: t.vendor_domain ?? null,
      note: t.note ?? null,
      icon: opts.catalog?.get(t.name)?.icon ?? null,
      description: opts.catalog?.get(t.name)?.description ?? null,
      sites,
      previous_sites: previous.get(t.slug) ?? null,
      by_rank: ranks.map((r) => ({ rank_bucket: r.rank_bucket, sites: r.sites })).sort(sortRank),
      top_sites: (topMap.get(t.tech_id) ?? [])
        .map((r) => ({ domain: r.domain, rank_bucket: r.rank_bucket }))
        .sort((a, b) => a.rank_bucket - b.rank_bucket || a.domain.localeCompare(b.domain)),
      co_used: sampledIds.has(t.tech_id)
        ? (pairMap.get(t.tech_id) ?? [])
            .filter((p) => byId.has(p.b))
            .map((p) => ({ slug: byId.get(p.b)!.slug, share: round4(p.n / p.na), base_share: round4(p.nb / total) }))
            .sort((a, b) => b.share - a.share || a.slug.localeCompare(b.slug))
        : null,
      cwv: ranks.reduce((acc, r) => ({ tested: acc.tested + r.tested, good: acc.good + r.good }), { tested: 0, good: 0 }),
      versions: (versionMap.get(t.tech_id) ?? []).map((v) => ({ version: v.version, sites: v.sites })).sort((a, b) => b.sites - a.sites),
      tlds: (tldMap.get(t.tech_id) ?? []).map((v) => ({ tld: v.tld, sites: v.sites })).sort((a, b) => b.sites - a.sites),
    }];
  }).sort((a, b) => b.sites - a.sites || a.slug.localeCompare(b.slug));

  const categorySites = new Map(categoryRows.map((c) => [c.name, c.sites_estimate]));
  const categoryTechs = new Map<string, string[]>();
  for (const t of technologies) {
    for (const c of t.categories) (categoryTechs.get(c) ?? categoryTechs.set(c, []).get(c)!).push(t.slug);
  }
  const categories: SeoCategory[] = [...categoryTechs.entries()]
    .map(([name, slugs]) => ({ slug: slugify(name), name, sites_estimate: categorySites.get(name) ?? 0, technologies: slugs }))
    .sort((a, b) => b.sites_estimate - a.sites_estimate || a.name.localeCompare(b.name));

  return {
    format_version: SEO_FORMAT_VERSION,
    crawl_date: snapshot.manifest.crawl_date,
    crux_date: snapshot.manifest.crux_date,
    built_at: (opts.now ?? new Date()).toISOString(),
    total_sites: overall.reduce((n, r) => n + r.sites, 0),
    by_rank: overall.map((r) => ({ rank_bucket: r.rank_bucket, sites: r.sites })).sort(sortRank),
    cwv: overall.reduce((acc, r) => ({ tested: acc.tested + r.tested, good: acc.good + r.good }), { tested: 0, good: 0 }),
    co_usage_sample_every: every,
    technologies,
    categories,
  };
}
