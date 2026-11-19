import { listValue, type DuckDBValue } from "@duckdb/node-api";
import { z } from "zod";
import { CWV_GOOD, RANK_BUCKETS } from "../data/schema.js";
import type { Snapshot } from "../data/snapshot.js";
import { OperationError } from "./types.js";

/**
 * The site filter shared by count_sites and search_sites: one zod definition,
 * one resolver and one SQL builder, so a count always matches the list it prices.
 */

/** REST sends lists as "a,b" or as repeated params; MCP sends real arrays. Accept all three. */
function splitList(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => (typeof item === "string" ? item.split(",") : [item]))
    .map((item) => (typeof item === "string" ? item.trim() : item))
    .filter((item) => item !== "");
}

const listOf = <T extends z.ZodType>(item: T, max: number) => z.preprocess(splitList, z.array(item).max(max));

/** REST sends CWV as "lcp:pass,cls:fail"; MCP sends an object. */
function parseCwv(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [metric, verdict] = pair.split(/[:=]/).map((s) => s.trim().toLowerCase());
    if (metric) out[metric] = verdict ?? "";
  }
  return out;
}

const slug = z.string().trim().toLowerCase().min(1).max(100);
const verdict = z.enum(["pass", "fail"]);
const rankBucket = z.union([
  z.literal("unknown"),
  z.coerce
    .number()
    .int()
    .refine((n) => (RANK_BUCKETS as readonly number[]).includes(n), {
      message: `Rank buckets are ${RANK_BUCKETS.join(", ")} or "unknown".`,
    }),
]);

export const DEVICES = ["mobile", "desktop", "any"] as const;
export type Device = (typeof DEVICES)[number];

export const siteFilterShape = {
  technologies: listOf(slug, 20)
    .optional()
    .describe('Technology slugs from find_technologies, e.g. ["shopify","klaviyo"]. REST: comma-separated.'),
  match: z
    .enum(["all", "any"])
    .default("all")
    .describe('"all" (default): sites using every listed technology. "any": sites using at least one.'),
  exclude_technologies: listOf(slug, 20)
    .optional()
    .describe("Technology slugs to rule out: sites using any of these are dropped."),
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('A technology category, e.g. "Email marketing" (case-insensitive). Sites using any technology in it match.'),
  version: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .optional()
    .describe('Version prefix for the matched technologies, e.g. "6" or "6.8" (matches 6.8.1, not 60.1).'),
  rank_buckets: listOf(rankBucket, RANK_BUCKETS.length + 1)
    .optional()
    .describe(
      `Popularity buckets to include: ${RANK_BUCKETS.join(", ")} (1000 = top 1k, 10000 = 1k to 10k, ...) or "unknown".`,
    ),
  max_rank: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only sites in the top N, e.g. 100000 for the top 100k. Sites with unknown rank are dropped."),
  tld: listOf(z.string().trim().toLowerCase().min(1).max(30), 50)
    .optional()
    .describe('Top-level domains, e.g. ["com","co.uk"]. REST: comma-separated.'),
  cwv: z
    .preprocess(
      parseCwv,
      z.object({ lcp: verdict.optional(), inp: verdict.optional(), cls: verdict.optional() }).strict(),
    )
    .optional()
    .describe(
      'Core Web Vitals at p75, "pass" (at or under Google\'s good threshold) or "fail", e.g. {"lcp":"pass"}. ' +
        "Sites without field data match neither. REST: lcp:pass,cls:fail.",
    ),
  device: z
    .enum(DEVICES)
    .default("any")
    .describe(
      '"mobile" or "desktop": the technologies must be detected on that device and CWV uses its field data. ' +
        '"any" (default): either device, CWV from mobile.',
    ),
};

export type SiteFilterInput = z.infer<z.ZodObject<typeof siteFilterShape>>;

export interface ResolvedFilters {
  /** Listed technologies, resolved to ids. */
  required: { tech_id: number; slug: string; name: string }[];
  match: "all" | "any";
  /** Technologies in the requested category, if one was given. */
  categoryTechIds: number[];
  excludedTechIds: number[];
  version?: string;
  rankBuckets?: (number | "unknown")[];
  maxRank?: number;
  tlds?: string[];
  cwv?: { lcp?: "pass" | "fail"; inp?: "pass" | "fail"; cls?: "pass" | "fail" };
  device: Device;
}

const invalid = (field: string, message: string, extra: Record<string, unknown> = {}) =>
  new OperationError("invalid_input", message, { issues: [{ field, message }], ...extra });

/** Checks slugs and the category against the snapshot and resolves them to tech ids. */
export async function resolveSiteFilters(snapshot: Snapshot, input: SiteFilterInput): Promise<ResolvedFilters> {
  const wanted = [...new Set(input.technologies ?? [])];
  const excluded = [...new Set(input.exclude_technologies ?? [])];
  if (wanted.length === 0 && !input.category) {
    throw invalid(
      "technologies",
      "Pass technologies (slugs from find_technologies), a category, or both.",
    );
  }
  const both = wanted.filter((s) => excluded.includes(s));
  if (both.length > 0) {
    throw invalid("exclude_technologies", `${both.join(", ")} can't be both required and excluded.`);
  }

  const all = [...wanted, ...excluded];
  const found =
    all.length === 0
      ? []
      : await snapshot.query<{ tech_id: number; slug: string; name: string }>(
          "SELECT tech_id, slug, name FROM technologies WHERE list_contains($1, slug)",
          [listValue(all)],
        );
  const bySlug = new Map(found.map((t) => [t.slug, t]));
  const unknown = all.filter((s) => !bySlug.has(s));
  if (unknown.length > 0) {
    throw invalid(
      wanted.some((s) => unknown.includes(s)) ? "technologies" : "exclude_technologies",
      `Unknown technology slug${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        "Call find_technologies to look up the right slug.",
      { unknown_technologies: unknown },
    );
  }

  let categoryTechIds: number[] = [];
  if (input.category) {
    const rows = await snapshot.query<{ tech_id: number }>(
      "SELECT tech_id FROM technologies WHERE list_contains(list_transform(categories, lambda c: lower(c)), lower($1))",
      [input.category],
    );
    if (rows.length === 0) {
      throw invalid(
        "category",
        `No technologies are in the category "${input.category}". Call find_technologies with it to see category names.`,
      );
    }
    categoryTechIds = rows.map((r) => r.tech_id);
  }

  return {
    required: wanted.map((s) => bySlug.get(s)!),
    match: input.match,
    categoryTechIds,
    excludedTechIds: excluded.map((s) => bySlug.get(s)!.tech_id),
    version: input.version,
    rankBuckets: input.rank_buckets,
    maxRank: input.max_rank,
    tlds: input.tld?.map((t) => t.replace(/^\.+/, "")),
    cwv: input.cwv,
    device: input.device,
  };
}

/** Collects positional parameters so SQL never contains user input. */
export class SqlParams {
  readonly values: DuckDBValue[] = [];
  add(value: DuckDBValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export const CWV_METRICS = ["lcp", "inp", "cls"] as const;
export type CwvMetric = (typeof CWV_METRICS)[number];

/** Which device's p75 columns CWV reads: "any" reads mobile. */
export function cwvDevice(device: Device): "mobile" | "desktop" {
  return device === "desktop" ? "desktop" : "mobile";
}

export interface CwvSummary {
  device: "mobile" | "desktop";
  lcp: { p75: number | null; pass: boolean | null };
  inp: { p75: number | null; pass: boolean | null };
  cls: { p75: number | null; pass: boolean | null };
}

/** p75s and pass/fail for one device, from a sites row. Pass is null without field data. */
export function cwvSummary(site: Record<string, unknown>, device: "mobile" | "desktop"): CwvSummary {
  const metric = (m: CwvMetric) => {
    const p75 = site[`${m}_p75_${device}`] as number | null | undefined;
    return { p75: p75 ?? null, pass: p75 === null || p75 === undefined ? null : p75 <= CWV_GOOD[m] };
  };
  return { device, lcp: metric("lcp"), inp: metric("inp"), cls: metric("cls") };
}

/**
 * The site_tech conditions a detection must meet to count as a match: the
 * version prefix and the device. Used for matching and for listing what matched.
 */
export function detectionConditions(f: ResolvedFilters, p: SqlParams, alias: string): string[] {
  const conds: string[] = [];
  if (f.version) {
    const v = p.add(f.version);
    conds.push(`(${alias}.version = ${v} OR starts_with(${alias}.version, ${v} || '.'))`);
  }
  if (f.device === "mobile") conds.push(`${alias}.on_mobile`);
  if (f.device === "desktop") conds.push(`${alias}.on_desktop`);
  return conds;
}

/** Every tech id a detection can match on: the listed technologies and the category's. */
export function matchedTechIds(f: ResolvedFilters): number[] {
  return [...new Set([...f.required.map((t) => t.tech_id), ...f.categoryTechIds])];
}

/** SELECT of the sites rows (alias s, all columns) that pass every filter. */
export function matchingSitesSql(f: ResolvedFilters, p: SqlParams): string {
  const having: string[] = [];
  if (f.required.length > 0) {
    const ids = p.add(listValue(f.required.map((t) => t.tech_id)));
    const need = f.match === "all" ? f.required.length : 1;
    having.push(`count(DISTINCT st.tech_id) FILTER (WHERE list_contains(${ids}, st.tech_id)) >= ${p.add(need)}`);
  }
  if (f.categoryTechIds.length > 0) {
    const ids = p.add(listValue(f.categoryTechIds));
    having.push(`count(*) FILTER (WHERE list_contains(${ids}, st.tech_id)) >= 1`);
  }
  const detection = [
    `list_contains(${p.add(listValue(matchedTechIds(f)))}, st.tech_id)`,
    ...detectionConditions(f, p, "st"),
  ];

  const where: string[] = [];
  if (f.excludedTechIds.length > 0) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM site_tech x WHERE x.site_id = s.site_id AND list_contains(${p.add(
        listValue(f.excludedTechIds),
      )}, x.tech_id))`,
    );
  }
  if (f.rankBuckets && f.rankBuckets.length > 0) {
    const numeric = f.rankBuckets.filter((b): b is number => b !== "unknown");
    const parts: string[] = [];
    if (numeric.length > 0) parts.push(`list_contains(${p.add(listValue(numeric))}, s.rank_bucket)`);
    if (f.rankBuckets.includes("unknown")) parts.push("s.rank_bucket IS NULL");
    where.push(`(${parts.join(" OR ")})`);
  }
  if (f.maxRank !== undefined) where.push(`s.rank_bucket <= ${p.add(f.maxRank)}`);
  if (f.tlds && f.tlds.length > 0) where.push(`list_contains(${p.add(listValue(f.tlds))}, lower(s.tld))`);
  if (f.cwv) {
    const device = cwvDevice(f.device);
    for (const m of CWV_METRICS) {
      const want = f.cwv[m];
      if (!want) continue;
      // Column names come from the fixed metric and device lists, never from input.
      where.push(`s.${m}_p75_${device} ${want === "pass" ? "<=" : ">"} ${p.add(CWV_GOOD[m])}`);
    }
  }

  return `
    SELECT s.* FROM sites s
    JOIN (
      SELECT st.site_id FROM site_tech st
      WHERE ${detection.join(" AND ")}
      GROUP BY st.site_id
      HAVING ${having.join(" AND ")}
    ) m ON m.site_id = s.site_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
  `;
}
