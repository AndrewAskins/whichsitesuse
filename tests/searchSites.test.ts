import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { countSites } from "../src/operations/countSites.js";
import { decodeCursor, encodeCursor, searchSites, sitesCsv } from "../src/operations/searchSites.js";
import { OperationError, type OperationContext } from "../src/operations/types.js";
import { testConfig } from "./helpers/config.js";
import { anonymousContext, fixedBilling } from "./helpers/context.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

let ctx: OperationContext;
let killed: OperationContext;
beforeAll(async () => {
  const dir = await buildFixtureSnapshot(QUERY_FIXTURE_ROWS);
  ctx = { ...anonymousContext(testConfig(), await Snapshot.open(dir, { serveHttpArchive: true })), billing: fixedBilling(1_000_000) };
  killed = { ...anonymousContext(testConfig(), await Snapshot.open(dir, { serveHttpArchive: false })), billing: fixedBilling(1_000_000) };
});
afterAll(() => {
  ctx.snapshot?.close();
  killed.snapshot?.close();
});

const search = (raw: Record<string, unknown>, c = ctx) => searchSites.run(searchSites.input.parse(raw), c);
const domains = async (raw: Record<string, unknown>) => (await search(raw)).data.sites.map((s) => s.domain);

describe("search_sites", () => {
  it("lists best-ranked sites first, then by domain, unknown rank last, 1 credit each", async () => {
    const { data, credits_used } = await search({ technologies: ["shopify"] });
    expect(data.sites.map((s) => s.domain)).toEqual([
      "store-d.co.uk",
      "shop-a.com",
      "shop-h.com",
      "store-e.com",
      "live-c.io",
    ]);
    expect(credits_used).toBe(5);
    expect(data.next_cursor).toBeNull();
  });

  it("returns the matched technologies and a mobile CWV summary", async () => {
    const { data } = await search({ technologies: ["shopify", "klaviyo"] });
    const shopA = data.sites.find((s) => s.domain === "shop-a.com")!;
    expect(shopA).toMatchObject({ root_url: "https://shop-a.com/", rank_bucket: 10000, tld: "com", source: "httparchive" });
    expect(shopA.technologies).toEqual([
      { name: "Klaviyo", slug: "klaviyo", version: null, first_seen: "2026-10-01", last_seen: "2026-10-01", confidence: 1 },
      { name: "Shopify", slug: "shopify", version: null, first_seen: "2026-10-01", last_seen: "2026-10-01", confidence: 1 },
    ]);
    expect(shopA.cwv).toEqual({
      device: "mobile",
      lcp: { p75: 2100, pass: true },
      inp: { p75: 150, pass: true },
      cls: { p75: 0.05, pass: true },
    });
  });

  it("reports the CWV of the requested device", async () => {
    const { data } = await search({ technologies: ["shopify"], device: "desktop", tld: "com" });
    const shopH = data.sites.find((s) => s.domain === "shop-h.com")!;
    expect(shopH.cwv.device).toBe("desktop");
    expect(shopH.cwv.lcp).toEqual({ p75: 2600, pass: false });
  });

  it("lists only what matched under match any", async () => {
    const { data } = await search({ technologies: "shopify,klaviyo", match: "any" });
    expect(data.sites.find((s) => s.domain === "wp-f.com")?.technologies.map((t) => t.slug)).toEqual(["klaviyo"]);
  });

  it("applies exclusions, category, version, rank, TLD and CWV filters", async () => {
    expect(await domains({ technologies: ["shopify"], exclude_technologies: ["klaviyo"] })).toEqual([
      "store-d.co.uk",
      "shop-h.com",
      "live-c.io",
    ]);
    expect(await domains({ category: "email marketing" })).toEqual(["store-d.co.uk", "shop-a.com", "wp-f.com", "store-e.com"]);
    expect(await domains({ technologies: ["wordpress"], version: "6" })).toEqual(["wp-f.com", "blog-b.org"]);
    expect(await domains({ technologies: ["shopify"], max_rank: 1000 })).toEqual(["store-d.co.uk"]);
    expect(await domains({ technologies: ["shopify"], tld: "co.uk" })).toEqual(["store-d.co.uk"]);
    expect(await domains({ technologies: ["shopify"], cwv: { lcp: "fail" } })).toEqual(["store-d.co.uk", "shop-h.com"]);
    expect(await domains({ technologies: ["shopify"], device: "mobile" })).not.toContain("store-e.com");
  });

  it("pages with a cursor, with no duplicates or gaps, and agrees with count_sites", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { data, credits_used } = await search({ technologies: ["shopify"], limit: 2, cursor });
      expect(credits_used).toBe(data.sites.length);
      seen.push(...data.sites.map((s) => s.domain));
      cursor = data.next_cursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(await domains({ technologies: ["shopify"] }));
    expect(new Set(seen).size).toBe(seen.length);
    const { data } = await countSites.run(countSites.input.parse({ technologies: ["shopify"] }), ctx);
    expect(seen).toHaveLength(data.total);
  });

  it("never returns more sites than max_credits", async () => {
    const { data, credits_used } = await search({ technologies: ["shopify"], max_credits: 3 });
    expect(data.sites).toHaveLength(3);
    expect(credits_used).toBe(3);
    expect(data.next_cursor).not.toBeNull();
    const next = await search({ technologies: ["shopify"], cursor: data.next_cursor });
    expect(next.data.sites.map((s) => s.domain)).toEqual(["store-e.com", "live-c.io"]);
  });

  it("returns nothing and charges nothing when max_credits is 0", async () => {
    const { data, credits_used } = await search({ technologies: ["shopify"], max_credits: 0 });
    expect(data.sites).toEqual([]);
    expect(credits_used).toBe(0);
  });

  it("round-trips cursors and rejects tampered ones", async () => {
    expect(decodeCursor(encodeCursor({ rank_bucket: null, domain: "a.com" }))).toEqual({ rank_bucket: null, domain: "a.com" });
    for (const bad of ["not-a-cursor", Buffer.from('{"x":1}').toString("base64url")]) {
      const err = await search({ technologies: ["shopify"], cursor: bad }).catch((e: unknown) => e);
      expect((err as OperationError).code).toBe("invalid_input");
    }
  });

  it("names unknown slugs", async () => {
    const err = await search({ technologies: ["shopify"], exclude_technologies: ["nope"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).message).toMatch(/nope/);
  });

  it("validates limit", () => {
    expect(searchSites.input.safeParse({ technologies: ["shopify"], limit: 1001 }).success).toBe(false);
    expect(searchSites.input.parse({ technologies: ["shopify"] }).limit).toBe(100);
  });

  it("serves only live crawl rows when the kill switch is off", async () => {
    const { data } = await search({ technologies: ["shopify"] }, killed);
    expect(data.sites.map((s) => s.domain)).toEqual(["live-c.io"]);
    expect(data.sites[0]?.technologies[0]).toMatchObject({ slug: "shopify", confidence: 0.9 });
  });

  it("renders CSV with escaping and no spreadsheet formulas", async () => {
    const { data } = await search({ technologies: ["shopify"], limit: 2 });
    const csv = sitesCsv({
      next_cursor: null,
      sites: [{ ...data.sites[0]!, domain: "=cmd.example", root_url: 'https://x.example/"a",b' }],
    });
    const [header, row] = csv.trim().split("\r\n");
    expect(header!.split(",")).toContain("lcp_pass");
    expect(row!.startsWith("'=cmd.example,")).toBe(true);
    expect(row).toContain('"https://x.example/""a"",b"');
  });

  it("refuses CSV for accounts that can't export", async () => {
    const trial = { ...ctx, billing: fixedBilling(100, { canExport: false }) };
    const err = await search({ technologies: ["shopify"], format: "csv" }, trial).catch((e: unknown) => e);
    expect((err as OperationError).code).toBe("export_not_allowed");
  });
});
