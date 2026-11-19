import { listValue } from "@duckdb/node-api";
import { z } from "zod";
import type { Snapshot } from "../data/snapshot.js";
import {
  cwvDevice,
  cwvSummary,
  detectionConditions,
  matchedTechIds,
  matchingSitesSql,
  resolveSiteFilters,
  siteFilterShape,
  SqlParams,
  type CwvSummary,
  type ResolvedFilters,
} from "./siteFilters.js";
import { CREDIT_COSTS, maxCreditsInput } from "./billing.js";
import { requireSnapshot } from "./snapshotGuard.js";
import { OperationError, type Operation } from "./types.js";

const input = z.object({
  ...siteFilterShape,
  limit: z.coerce.number().int().min(1).max(1000).default(100).describe("Most sites to return (1 to 1000)."),
  ...maxCreditsInput,
  cursor: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe("next_cursor from the previous page, unchanged, to get the next page."),
});

export interface MatchedTechnology {
  name: string;
  slug: string;
  version: string | null;
  first_seen: string | null;
  last_seen: string | null;
  confidence: number | null;
}

export interface SiteResult {
  domain: string;
  root_url: string;
  rank_bucket: number | null;
  tld: string | null;
  technologies: MatchedTechnology[];
  cwv: CwvSummary;
  source: string;
}

export interface SiteSearch {
  sites: SiteResult[];
  /** Pass to the next call as cursor; null when there are no more sites. */
  next_cursor: string | null;
}

interface Cursor {
  rank_bucket: number | null;
  domain: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.rank_bucket, c.domain])).toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      (value[0] === null || Number.isInteger(value[0])) &&
      typeof value[1] === "string"
    ) {
      return { rank_bucket: value[0] as number | null, domain: value[1] };
    }
  } catch {
    // fall through
  }
  const message = "This cursor isn't valid. Pass next_cursor from the previous page unchanged.";
  throw new OperationError("invalid_input", message, { issues: [{ field: "cursor", message }] });
}

type SiteRow = Record<string, unknown> & {
  site_id: number;
  domain: string;
  root_url: string;
  rank_bucket: number | null;
  tld: string | null;
  source: string;
};

export const searchSites: Operation<typeof input.shape, SiteSearch> = {
  name: "search_sites",
  title: "Search sites",
  description:
    "List the sites that use a technology (reverse lookup), with filters for other technologies, " +
    "category, version, popularity rank, TLD and Core Web Vitals. Best-ranked sites first; each result " +
    "has the matched technologies with first/last seen dates and a CWV summary. Costs 1 credit per site " +
    "returned: call count_sites first (free) to see the total, and pass max_credits to cap spend. " +
    "Page with next_cursor.",
  rest: { method: "get", path: "/sites" },
  pricing: "paid",
  input,
  async run(args, ctx) {
    const snapshot = requireSnapshot(ctx);
    const filters = await resolveSiteFilters(snapshot, args);
    const after = args.cursor ? decodeCursor(args.cursor) : null;
    // One credit per site: never return more than the call may spend, or than trial accounts may see at once.
    const budget = Math.floor(Math.min(ctx.billing.available, args.max_credits ?? Infinity) / CREDIT_COSTS.site);
    const pageSize = Math.min(args.limit, budget, ctx.billing.maxResults ?? args.limit);
    if (pageSize === 0 && args.max_credits !== 0) {
      // Out of credits (or a key cap): a 402 with checkout links, not a silent empty page.
      ctx.billing.require(CREDIT_COSTS.site);
    }
    if (pageSize === 0) {
      // Nothing spent; the same cursor still points at the next site.
      return { data: { sites: [], next_cursor: args.cursor ?? null }, credits_used: 0 };
    }

    const p = new SqlParams();
    const base = matchingSitesSql(filters, p);
    let seek = "";
    if (after) {
      const d = p.add(after.domain);
      if (after.rank_bucket === null) {
        seek = `WHERE rank_bucket IS NULL AND domain > ${d}`;
      } else {
        const r = p.add(after.rank_bucket);
        seek = `WHERE rank_bucket > ${r} OR (rank_bucket = ${r} AND domain > ${d}) OR rank_bucket IS NULL`;
      }
    }
    // One extra row tells us whether another page exists.
    const rows = await snapshot.query<SiteRow>(
      `SELECT * FROM (${base}) ${seek} ORDER BY rank_bucket ASC NULLS LAST, domain LIMIT ${p.add(pageSize + 1)}`,
      p.values,
    );
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    const next_cursor =
      rows.length > pageSize && last ? encodeCursor({ rank_bucket: last.rank_bucket, domain: last.domain }) : null;

    const techs = await matchedTechnologies(snapshot, filters, page.map((s) => s.site_id));
    const device = cwvDevice(filters.device);
    const sites: SiteResult[] = page.map((s) => ({
      domain: s.domain,
      root_url: s.root_url,
      rank_bucket: s.rank_bucket,
      tld: s.tld,
      technologies: techs.get(s.site_id) ?? [],
      cwv: cwvSummary(s, device),
      source: s.source,
    }));
    return { data: { sites, next_cursor }, credits_used: sites.length * CREDIT_COSTS.site };
  },
};

async function matchedTechnologies(
  snapshot: Snapshot,
  filters: ResolvedFilters,
  siteIds: number[],
): Promise<Map<number, MatchedTechnology[]>> {
  const out = new Map<number, MatchedTechnology[]>();
  if (siteIds.length === 0) return out;
  const p = new SqlParams();
  const conds = [
    `list_contains(${p.add(listValue(siteIds))}, st.site_id)`,
    `list_contains(${p.add(listValue(matchedTechIds(filters)))}, st.tech_id)`,
    ...detectionConditions(filters, p, "st"),
  ];
  const rows = await snapshot.query<MatchedTechnology & { site_id: number }>(
    `
    SELECT st.site_id, t.name, t.slug, st.version,
      st.first_seen::VARCHAR AS first_seen, st.last_seen::VARCHAR AS last_seen, st.confidence
    FROM site_tech st JOIN technologies t ON t.tech_id = st.tech_id
    WHERE ${conds.join(" AND ")}
    ORDER BY st.site_id, t.name
    `,
    p.values,
  );
  for (const { site_id, ...tech } of rows) {
    const list = out.get(site_id) ?? [];
    list.push(tech);
    out.set(site_id, list);
  }
  return out;
}
