import type { SeoDataset } from "./dataset.js";

/** What the published pages must never show. Every count has to be 0 before a dataset is published. */
export interface SeoDatasetCheck {
  pages: number;
  /** Technologies or categories whose list names one entry twice. */
  duplicate_lists: number;
  /** Top-sites entries whose domain, or its parent, is on the adult blocklist. */
  adult_top_sites: number;
  /** Co-usage shares above 100%. */
  co_usage_over_100: number;
  examples: string[];
}

export function checkSeoDataset(data: SeoDataset, adultDomains: readonly string[]): SeoDatasetCheck {
  const adult = new Set(adultDomains);
  const isAdult = (d: string) => adult.has(d) || adult.has(d.replace(/^[^.]+\./, ""));
  const hasDupes = (xs: string[]) => new Set(xs).size !== xs.length;
  const check: SeoDatasetCheck = {
    pages: data.technologies.length + data.categories.length,
    duplicate_lists: 0,
    adult_top_sites: 0,
    co_usage_over_100: 0,
    examples: [],
  };
  const note = (s: string) => void (check.examples.length < 10 && check.examples.push(s));
  for (const t of data.technologies) {
    const lists = [t.top_sites.map((s) => s.domain), (t.co_used ?? []).map((c) => c.slug), t.versions.map((v) => v.version), t.tlds.map((x) => x.tld)];
    if (lists.some(hasDupes)) (check.duplicate_lists++, note(`duplicate in ${t.slug}`));
    for (const s of t.top_sites) if (isAdult(s.domain)) (check.adult_top_sites++, note(`adult ${s.domain} on ${t.slug}`));
    for (const c of t.co_used ?? []) if (c.share > 1 || c.base_share > 1) (check.co_usage_over_100++, note(`${c.slug} over 100% on ${t.slug}`));
  }
  for (const c of data.categories) if (hasDupes(c.technologies)) (check.duplicate_lists++, note(`duplicate in category ${c.slug}`));
  return check;
}

export const checkPassed = (c: SeoDatasetCheck) => c.duplicate_lists === 0 && c.adult_top_sites === 0 && c.co_usage_over_100 === 0;
