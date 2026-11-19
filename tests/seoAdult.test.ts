import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { buildSeoDataset, type SeoDataset } from "../src/seo/dataset.js";
import { buildFixtureSnapshot, detection, QUERY_FIXTURE_ROWS, site } from "./helpers/fixtureSnapshot.js";

let snapshot: Snapshot;
let data: SeoDataset;

// Shopify gains three top-1k sites: one with an adult term in its domain, one that
// runs an adult ad network, and one in Essex, whose name only looks like a match.
beforeAll(async () => {
  snapshot = await Snapshot.open(
    await buildFixtureSnapshot({
      technologies: [
        ...QUERY_FIXTURE_ROWS.technologies,
        { tech_id: 6, name: "ExoClick", slug: "exoclick", categories: ["Advertising"], vendor_domain: null, aliases: [], note: null, site_count: 1 },
      ],
      sites: [
        ...QUERY_FIXTURE_ROWS.sites,
        site({ site_id: 9, domain: "hotporn.com", root_url: "https://hotporn.com/", rank_bucket: 1000, tld: "com" }),
        site({ site_id: 10, domain: "tube-j.net", root_url: "https://tube-j.net/", rank_bucket: 1000, tld: "net" }),
        site({ site_id: 11, domain: "essex-shop.co.uk", root_url: "https://essex-shop.co.uk/", rank_bucket: 1000, tld: "co.uk" }),
      ],
      site_tech: [...QUERY_FIXTURE_ROWS.site_tech, detection(9, 1), detection(10, 1), detection(10, 6), detection(11, 1)],
    }),
    { serveHttpArchive: true },
  );
  data = await buildSeoDataset(snapshot, { rules: { minPageSites: 1 } });
});
afterAll(() => snapshot.close());

describe("adult sites on the programmatic pages", () => {
  const shopify = () => data.technologies.find((t) => t.slug === "shopify")!;

  it("leaves adult domains and sites on adult ad networks out of the named top sites", () => {
    expect(shopify().top_sites.map((s) => s.domain)).toEqual([
      "essex-shop.co.uk",
      "store-d.co.uk",
      "shop-a.com",
      "shop-h.com",
      "store-e.com",
    ]);
  });

  it("still counts them", () => {
    expect(shopify().sites).toBe(8);
    expect(shopify().by_rank[0]).toEqual({ rank_bucket: 1000, sites: 4 });
  });
});
