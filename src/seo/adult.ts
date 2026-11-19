/**
 * Adult sites are left out of the named top-sites tables on the programmatic pages
 * (they're still counted everywhere else). Two signals, either one is enough:
 * the site runs an ad network that only serves adult sites, or its domain has an
 * adult term in it. Both lists are deliberately short and specific: a miss shows
 * one site in a table, a false match only drops a site from a table.
 */

/** HTTP Archive technology names of ad networks that serve adult sites. */
export const ADULT_AD_NETWORKS: readonly string[] = [
  "ExoClick",
  "JuicyAds",
  "TrafficJunky",
  "TrafficStars",
  "EroAdvertising",
  "PlugRush",
];

/** Substrings of a domain that mark it as adult. */
export const ADULT_DOMAIN_TERMS: readonly string[] = [
  "porn", "xxx", "xvideo", "xvidio", "xnxx", "xhamster", "hentai", "hanime", "sex", "nude", "nsfw",
  "erotic", "fuck", "milf", "rule34", "onlyfans", "chaturbate", "stripchat", "bongacams", "livejasmin",
  "camsoda", "spankbang", "redtube", "youporn", "brazzers", "eporner", "imagefap", "doujin", "bokep",
  "javhd", "orgasm", "escort", "fap",
];

/** Place names and words that contain a term above but aren't adult. */
export const ADULT_DOMAIN_EXCEPTIONS: readonly string[] = ["essex", "sussex", "middlesex", "wessex", "sextant", "sexton"];

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

/**
 * SQL that creates TEMP TABLE adult_sites (site_id), from the snapshot's sites,
 * technologies and site_tech tables. Only constants from this file go into it.
 */
export function adultSitesSql(): string {
  const pattern = ADULT_DOMAIN_TERMS.join("|");
  const exceptions = ADULT_DOMAIN_EXCEPTIONS.join("|");
  return `
    CREATE OR REPLACE TEMP TABLE adult_sites AS
    SELECT DISTINCT st.site_id FROM site_tech st JOIN technologies t USING (tech_id)
    WHERE t.name IN (${sqlList(ADULT_AD_NETWORKS)})
    UNION
    SELECT site_id FROM sites
    WHERE regexp_matches(regexp_replace(domain, '${exceptions}', '', 'g'), '${pattern}')`;
}
