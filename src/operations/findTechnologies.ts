import { z } from "zod";
import { requireSnapshot } from "./snapshotGuard.js";
import type { Operation } from "./types.js";

const input = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('A technology or category in plain words, e.g. "shopify", "wordpress", "email marketing".'),
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Most matches to return (1 to 50)."),
});

export interface TechnologyMatch {
  tech_id: number;
  name: string;
  slug: string;
  categories: string[];
  vendor_domain: string | null;
  note: string | null;
  site_count: number;
}

/** Letters and digits only, so "Word Press" and "wordpress" match. */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const KEY = (col: string) => `regexp_replace(lower(${col}), '[^a-z0-9]+', '', 'g')`;

export const findTechnologies: Operation<typeof input.shape, { matches: TechnologyMatch[] }> = {
  name: "find_technologies",
  title: "Find technologies",
  description:
    "Resolve a plain-language technology or category name to WhichSitesUse's canonical technologies, " +
    "with disambiguation notes and how many sites use each. Call this first, then pass the returned " +
    "slugs to count_sites or search_sites. Free.",
  rest: { method: "get", path: "/technologies" },
  input,
  async run({ q, limit }, ctx) {
    const snapshot = requireSnapshot(ctx);
    const key = normalizeKey(q);
    const lowered = q.toLowerCase();
    // Exact name or alias first, then prefix, then substring, then category matches.
    const rows = await snapshot.query<TechnologyMatch & { match_rank: number }>(
      `
      SELECT tech_id, name, slug, categories, vendor_domain, note, site_count,
        CASE
          WHEN ${KEY("name")} = $1 OR contains(${aliasKeys()}, '|' || $1 || '|') THEN 0
          WHEN starts_with(${KEY("name")}, $1) THEN 1
          WHEN contains(${KEY("name")}, $1) OR contains(${aliasKeys()}, $1) THEN 2
          ELSE 3
        END AS match_rank
      FROM technologies
      WHERE ($1 <> '' AND (contains(${KEY("name")}, $1) OR contains(${aliasKeys()}, $1)))
         OR contains(lower(array_to_string(categories, '|')), $2)
      ORDER BY match_rank, site_count DESC, name
      LIMIT $3
      `,
      [key, lowered, limit],
    );
    return {
      data: { matches: rows.map(({ match_rank: _rank, ...match }) => match) },
      credits_used: 0,
    };
  },
};

function aliasKeys(): string {
  // Aliases joined with "|" and normalized per alias, so "|shopifyplus|" can match exactly.
  return `'|' || array_to_string(list_transform(aliases, lambda a: ${KEY("a")}), '|') || '|'`;
}
