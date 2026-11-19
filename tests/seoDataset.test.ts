import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { buildSeoDataset, slugify, type SeoDataset } from "../src/seo/dataset.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

let snapshot: Snapshot;
let data: SeoDataset;
const rules = { minPageSites: 1, coUsageSampleEvery: 1, coUsageMinSample: 1, coUsageMinLift: 0, coUsageMinPair: 1 };

beforeAll(async () => {
  snapshot = await Snapshot.open(await buildFixtureSnapshot(QUERY_FIXTURE_ROWS), { serveHttpArchive: true });
  data = await buildSeoDataset(snapshot, { rules, now: new Date("2026-11-20T00:00:00Z") });
});
afterAll(() => snapshot.close());

const tech = (slug: string) => data.technologies.find((t) => t.slug === slug)!;

describe("buildSeoDataset", () => {
  it("carries the crawl and site totals", () => {
    expect(data.crawl_date).toBe("2026-10-01");
    expect(data.total_sites).toBe(8);
    expect(data.by_rank.at(-1)).toEqual({ rank_bucket: null, sites: 2 });
  });

  it("counts a technology by rank bucket, best bucket first", () => {
    const shopify = tech("shopify");
    expect(shopify.by_rank).toEqual([
      { rank_bucket: 1000, sites: 1 },
      { rank_bucket: 10000, sites: 2 },
      { rank_bucket: 100000, sites: 1 },
      { rank_bucket: null, sites: 1 },
    ]);
  });

  it("lists named sites best rank first and leaves unranked sites out", () => {
    expect(tech("shopify").top_sites.map((s) => s.domain)).toEqual(["store-d.co.uk", "shop-a.com", "shop-h.com", "store-e.com"]);
  });

  it("counts CWV passes on mobile field data", () => {
    // shop-a passes all three, store-d fails LCP, shop-h fails LCP; store-e and live-c have no mobile data.
    expect(tech("shopify").cwv).toEqual({ tested: 3, good: 1 });
  });

  it("groups versions to major.minor and counts TLDs", () => {
    expect(tech("wordpress").versions).toEqual(
      expect.arrayContaining([{ version: "6.8", sites: 1 }, { version: "6.4", sites: 1 }, { version: "5.9", sites: 1 }]),
    );
    expect(tech("shopify").tlds[0]).toEqual({ tld: "com", sites: 3 });
  });

  it("finds technologies used alongside", () => {
    const co = tech("shopify").co_used!;
    expect(co.map((c) => c.slug)).toContain("klaviyo");
    const klaviyo = co.find((c) => c.slug === "klaviyo")!;
    expect(klaviyo.share).toBe(0.4); // 2 of 5 Shopify sites
  });

  it("groups pages into categories", () => {
    const email = data.categories.find((c) => c.slug === "email-marketing")!;
    expect(email.technologies).toEqual(["klaviyo", "doppler"]);
    expect(email.sites_estimate).toBe(4);
  });

  it("records last month's count for change", async () => {
    const next = await buildSeoDataset(snapshot, { rules, previous: data });
    expect(next.technologies.find((t) => t.slug === "shopify")!.previous_sites).toBe(tech("shopify").sites);
  });

  it("leaves out technologies under the page threshold", async () => {
    const strict = await buildSeoDataset(snapshot, { rules: { ...rules, minPageSites: 3 } });
    // The fixture's technologies.site_count is hand-set (Shopify 3, the rest lower), and it is the first filter.
    expect(strict.technologies.map((t) => t.slug)).toEqual(["shopify"]);
  });

  it("slugifies category names", () => {
    expect(slugify("Email marketing")).toBe("email-marketing");
    expect(slugify("Tag managers & analytics")).toBe("tag-managers-and-analytics");
  });
});
