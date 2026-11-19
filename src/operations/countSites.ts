import { z } from "zod";
import { matchingSitesSql, resolveSiteFilters, siteFilterShape, SqlParams } from "./siteFilters.js";
import { requireSnapshot } from "./snapshotGuard.js";
import type { Operation } from "./types.js";

const input = z.object(siteFilterShape);

export interface RankBucketCount {
  /** Upper bound of the bucket (1000 = top 1k), or null for sites with unknown rank. */
  rank_bucket: number | null;
  sites: number;
}

export interface SiteCount {
  total: number;
  by_rank_bucket: RankBucketCount[];
  /** What search_sites would charge for every matching site (1 credit per site). */
  full_list_credits: number;
}

export const countSites: Operation<typeof input.shape, SiteCount> = {
  name: "count_sites",
  title: "Count sites",
  description:
    "Count the sites that match a technology filter, broken down by popularity rank bucket, and see what " +
    "the full list would cost (full_list_credits; search_sites charges 1 credit per site returned). " +
    "Free: call this before search_sites to size and price a list, then narrow the filter or cap spend " +
    "with max_credits. Takes the same filters as search_sites.",
  rest: { method: "get", path: "/counts" },
  input,
  async run(args, ctx) {
    const snapshot = requireSnapshot(ctx);
    const filters = await resolveSiteFilters(snapshot, args);
    const p = new SqlParams();
    const rows = await snapshot.query<{ rank_bucket: number | null; sites: number }>(
      `SELECT rank_bucket, count(*)::INTEGER AS sites FROM (${matchingSitesSql(filters, p)}) GROUP BY rank_bucket`,
      p.values,
    );
    // Buckets come from the data (HTTP Archive uses 1000, 5000, 10000, 50000, ...), most popular first, unknown last.
    const by_rank_bucket = rows
      .map((r) => ({ rank_bucket: r.rank_bucket, sites: r.sites }))
      .sort((a, b) => (a.rank_bucket ?? Infinity) - (b.rank_bucket ?? Infinity));
    const total = rows.reduce((sum, r) => sum + r.sites, 0);
    return { data: { total, by_rank_bucket, full_list_credits: total }, credits_used: 0 };
  },
};
