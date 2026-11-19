/**
 * The quality bar for the programmatic pages, in one place. The plan in Notion
 * ("WhichSitesUse programmatic SEO plan") explains each number.
 */
export interface SeoRules {
  minPageSites: number;
  minIndexSites: number;
  minIndexTopSites: number;
  maxIndexedTechPages: number;
  minCategoryTechs: number;
  topSites: number;
  topSitesMaxRank: number;
  coUsageSampleEvery: number;
  coUsageMinSample: number;
  coUsageMinLift: number;
  coUsageMinPair: number;
  coUsageMax: number;
  cwvMinTested: number;
  maxVersions: number;
  maxTlds: number;
}

export const SEO_RULES: Readonly<SeoRules> = {
  /** A technology gets a page at all once this many sites run it. Below this: 404. */
  minPageSites: 100,
  /** ...and the page is indexable (in the sitemap, no noindex) from this many sites. */
  minIndexSites: 1_000,
  /** An indexable technology page must list at least this many named sites. */
  minIndexTopSites: 10,
  /** Indexing goes out in waves: only the N technologies with the most sites are indexable. */
  maxIndexedTechPages: 500,
  /** A category page is indexable when it ranks at least this many indexable technologies. */
  minCategoryTechs: 3,
  /** Named sites shown per technology (highest CrUX rank first). */
  topSites: 25,
  /** Only sites in or above this rank bucket are listed by name. */
  topSitesMaxRank: 1_000_000,
  /** Co-usage is estimated from 1 in N sites, chosen by a hash of the site id. */
  coUsageSampleEvery: 25,
  /** A technology needs this many sampled sites before co-usage is shown. */
  coUsageMinSample: 40,
  /** A companion technology has to be at least this many times more common than across all sites. */
  coUsageMinLift: 1.5,
  /** ...and seen together on at least this many sampled sites. */
  coUsageMinPair: 5,
  coUsageMax: 10,
  /** CWV pass rate is shown once this many of a technology's sites have all three mobile metrics. */
  cwvMinTested: 200,
  /** Version and TLD rows shown. */
  maxVersions: 6,
  maxTlds: 6,
};

export const SITE_ORIGIN = "https://whichsitesuse.com";
