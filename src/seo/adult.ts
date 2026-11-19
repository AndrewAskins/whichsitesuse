/**
 * Adult sites are left out of the named top-sites tables on the programmatic pages
 * (they're still counted everywhere else). Three signals, any one is enough: the
 * domain (or its parent) is on a maintained adult blocklist, the site runs an ad
 * network that only serves adult sites, or its domain has an adult term in it.
 * A false match only drops a site from a table, so the signals lean wide.
 */

/**
 * StevenBlack's "porn-only" hosts file: about 77k domains merged from five maintained
 * adult blocklists, updated weekly. Downloaded at each dataset build, never stored.
 */
export const ADULT_BLOCKLIST_URL = "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts";

/** Below this many domains the download is treated as broken rather than used. */
export const ADULT_BLOCKLIST_MIN = 10_000;

/** Domains from a hosts file ("0.0.0.0 example.com"), lowercased, without www., unique. */
export function parseHostsList(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)\s*(?:#.*)?$/i.exec(line);
    if (!m) continue;
    const domain = m[1]!.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (domain.includes(".") && domain !== "0.0.0.0" && domain !== "localhost") out.add(domain);
  }
  return [...out];
}

/** Downloads the blocklist. Throws rather than return a short list, so pages never publish unfiltered. */
export async function fetchAdultBlocklist(fetchFn: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchFn(ADULT_BLOCKLIST_URL);
  if (!res.ok) throw new Error(`adult blocklist download failed: HTTP ${res.status}`);
  const domains = parseHostsList(await res.text());
  if (domains.length < ADULT_BLOCKLIST_MIN) throw new Error(`adult blocklist has only ${domains.length} domains`);
  return domains;
}

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
 * technologies and site_tech tables plus TEMP TABLE adult_list (domain), which
 * adultListSql fills. Only constants from this file go into it.
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
    WHERE regexp_matches(regexp_replace(domain, '${exceptions}', '', 'g'), '${pattern}')
    UNION
    SELECT s.site_id FROM sites s JOIN adult_list a ON a.domain = s.domain
    UNION
    -- m.example.com, de.example.com: a listed parent marks the subdomain too.
    SELECT s.site_id FROM sites s JOIN adult_list a ON a.domain = regexp_replace(s.domain, '^[^.]+\\.', '')`;
}

/** The blocklist domains as one SQL statement creating TEMP TABLE adult_list. */
export function adultListSql(domains: readonly string[]): string {
  const clean = domains.filter((d) => /^[a-z0-9.-]+$/.test(d));
  if (clean.length === 0) return "CREATE OR REPLACE TEMP TABLE adult_list (domain VARCHAR)";
  return `CREATE OR REPLACE TEMP TABLE adult_list AS SELECT DISTINCT unnest([${clean.map((d) => `'${d}'`).join(",")}]) AS domain`;
}
