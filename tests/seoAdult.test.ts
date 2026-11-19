import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { ADULT_BLOCKLIST_MIN, ADULT_DOMAINS_EXTRA, fetchAdultBlocklist, parseHostsList } from "../src/seo/adult.js";
import { checkPassed, checkSeoDataset } from "../src/seo/check.js";
import { buildSeoDataset, type SeoDataset } from "../src/seo/dataset.js";
import { buildFixtureSnapshot, detection, QUERY_FIXTURE_ROWS, site } from "./helpers/fixtureSnapshot.js";

let snapshot: Snapshot;
let data: SeoDataset;

// Shopify gains five top-1k sites: one with an adult term in its domain, one that
// runs an adult ad network, one in Essex, whose name only looks like a match, and
// two caught only by the blocklist (qorno.com itself, and a subdomain of a listed site).
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
        site({ site_id: 12, domain: "qorno.com", root_url: "https://qorno.com/", rank_bucket: 1000, tld: "com" }),
        site({ site_id: 13, domain: "m.listed-k.com", root_url: "https://m.listed-k.com/", rank_bucket: 1000, tld: "com" }),
      ],
      site_tech: [
        ...QUERY_FIXTURE_ROWS.site_tech,
        detection(9, 1),
        detection(10, 1),
        detection(10, 6),
        detection(11, 1),
        detection(12, 1),
        detection(13, 1),
      ],
    }),
    { serveHttpArchive: true },
  );
  data = await buildSeoDataset(snapshot, { rules: { minPageSites: 1 }, adultDomains: ["qorno.com", "listed-k.com"] });
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
    expect(shopify().sites).toBe(10);
    expect(shopify().by_rank[0]).toEqual({ rank_bucket: 1000, sites: 6 });
  });
});

describe("the adult blocklist", () => {
  it("reads domains from a hosts file", () => {
    const text = "# comment\n0.0.0.0 0.0.0.0\n127.0.0.1 localhost\n0.0.0.0 qorno.com\n0.0.0.0 www.Qorno.com\n0.0.0.0 okxxx1.com # note\n\n";
    expect(parseHostsList(text)).toEqual(["qorno.com", "okxxx1.com"]);
  });

  it("refuses a short or failed download, so pages never publish unfiltered", async () => {
    const ok = (body: string) => (async () => new Response(body)) as unknown as typeof fetch;
    await expect(fetchAdultBlocklist(ok("0.0.0.0 qorno.com\n"))).rejects.toThrow("only 1 domains");
    await expect(fetchAdultBlocklist((async () => new Response("", { status: 500 })) as unknown as typeof fetch)).rejects.toThrow("HTTP 500");
    const big = Array.from({ length: ADULT_BLOCKLIST_MIN }, (_, i) => `0.0.0.0 site${i}.com`).join("\n");
    const list = await fetchAdultBlocklist(ok(big));
    expect(list).toHaveLength(ADULT_BLOCKLIST_MIN + ADULT_DOMAINS_EXTRA.length);
    expect(list).toContain("av19t.com");
  });
});

describe("checkSeoDataset", () => {
  it("passes the filtered dataset", () => {
    const check = checkSeoDataset(data, ["qorno.com", "listed-k.com"]);
    expect(check).toMatchObject({ duplicate_lists: 0, adult_top_sites: 0, co_usage_over_100: 0 });
    expect(checkPassed(check)).toBe(true);
  });

  it("counts duplicates, listed adult sites and shares over 100%", () => {
    const shopify = data.technologies.find((t) => t.slug === "shopify")!;
    const bad = {
      ...data,
      technologies: [
        {
          ...shopify,
          top_sites: [...shopify.top_sites, shopify.top_sites[0]!, { domain: "aznude.com", rank_bucket: 1000 }],
          co_used: [{ slug: "klaviyo", share: 1.6, base_share: 0.4 }],
        },
      ],
    };
    const check = checkSeoDataset(bad, ["aznude.com"]);
    expect(check).toMatchObject({ duplicate_lists: 1, adult_top_sites: 1, co_usage_over_100: 1 });
    expect(checkPassed(check)).toBe(false);
  });
});
