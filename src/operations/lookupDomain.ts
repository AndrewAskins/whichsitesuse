import { z } from "zod";
import { cwvSummary, type CwvSummary } from "./siteFilters.js";
import { requireSnapshot } from "./snapshotGuard.js";
import { OperationError, type Operation } from "./types.js";

const input = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .describe('A domain or URL, e.g. "example.com" or "https://www.example.com/pricing". Scheme, path, port and www. are ignored.'),
});

/** Price of a covered lookup; a domain the snapshot doesn't cover is free. */
export const LOOKUP_DOMAIN_CREDITS = 2;

export interface StackTechnology {
  name: string;
  slug: string;
  version: string | null;
  categories: string[];
  first_seen: string | null;
  last_seen: string | null;
  confidence: number | null;
}

export interface StackCategory {
  category: string;
  technologies: StackTechnology[];
}

export interface CoveredDomain {
  covered: true;
  domain: string;
  root_url: string;
  rank_bucket: number | null;
  tld: string | null;
  /** Grouped by each technology's primary (first) category; `categories` on each lists them all. */
  stack: StackCategory[];
  cwv: { mobile: CwvSummary; desktop: CwvSummary };
  last_crawl_date: string | null;
  source: string;
}

export interface UncoveredDomain {
  covered: false;
  domain: string;
  message: string;
}

/** Lowercase host only: no scheme, userinfo, path, query, port, trailing dot or leading "www.". */
export function normalizeDomain(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `http://${text.replace(/^\/+/, "")}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

type SiteRow = Record<string, unknown> & {
  site_id: number;
  domain: string;
  root_url: string;
  rank_bucket: number | null;
  tld: string | null;
  last_crawl_date: string | null;
  source: string;
};

export const lookupDomain: Operation<typeof input.shape, CoveredDomain | UncoveredDomain> = {
  name: "lookup_domain",
  title: "Look up a domain",
  description:
    "Get the full technology stack of one domain, grouped by category, with versions and first/last seen " +
    "dates, plus its popularity rank bucket and Core Web Vitals on mobile and desktop. Costs 2 credits. " +
    "If the domain isn't in the dataset the answer says covered: false and costs nothing.",
  rest: { method: "get", path: "/domains/:domain" },
  input,
  async run({ domain: raw }, ctx) {
    const snapshot = requireSnapshot(ctx);
    const domain = normalizeDomain(raw);
    if (!domain) {
      const message = `"${raw}" doesn't look like a domain. Pass something like example.com.`;
      throw new OperationError("invalid_input", message, { issues: [{ field: "domain", message }] });
    }

    const [site] = await snapshot.query<SiteRow>(
      "SELECT * REPLACE (last_crawl_date::VARCHAR AS last_crawl_date) FROM sites WHERE domain = $1 LIMIT 1",
      [domain],
    );
    if (!site) {
      return {
        data: {
          covered: false,
          domain,
          message:
            `${domain} isn't in this month's crawl. HTTP Archive covers sites with real Chrome traffic ` +
            "(from the Chrome UX Report), so small, new or private sites are often missing. No credits were charged.",
        },
        credits_used: 0,
      };
    }

    const techs = await snapshot.query<StackTechnology>(
      `
      SELECT t.name, t.slug, st.version, t.categories,
        st.first_seen::VARCHAR AS first_seen, st.last_seen::VARCHAR AS last_seen, st.confidence
      FROM site_tech st JOIN technologies t ON t.tech_id = st.tech_id
      WHERE st.site_id = $1
      ORDER BY t.name
      `,
      [site.site_id],
    );
    const groups = new Map<string, StackTechnology[]>();
    for (const tech of techs) {
      const category = tech.categories[0] ?? "Other";
      groups.set(category, [...(groups.get(category) ?? []), tech]);
    }
    const stack = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, technologies]) => ({ category, technologies }));

    return {
      data: {
        covered: true,
        domain: site.domain,
        root_url: site.root_url,
        rank_bucket: site.rank_bucket,
        tld: site.tld,
        stack,
        cwv: { mobile: cwvSummary(site, "mobile"), desktop: cwvSummary(site, "desktop") },
        last_crawl_date: site.last_crawl_date,
        source: site.source,
      },
      credits_used: LOOKUP_DOMAIN_CREDITS,
    };
  },
};
