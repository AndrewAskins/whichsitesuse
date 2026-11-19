import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { technologyReports } from "../src/pipeline/report.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

let snapshot: Snapshot;
beforeAll(async () => {
  snapshot = await Snapshot.open(await buildFixtureSnapshot(QUERY_FIXTURE_ROWS), { serveHttpArchive: true });
});
afterAll(() => snapshot.close());

describe("technology reports for site copy", () => {
  it("profiles a technology: counts, buckets, examples, CWV, neighbours, TLDs", async () => {
    const [shopify] = await technologyReports(snapshot, "shopify");
    expect(shopify).toMatchObject({ name: "Shopify", slug: "shopify", sites: 5 });
    expect(shopify!.by_rank_bucket.reduce((n, b) => n + b.sites, 0)).toBe(5);
    expect(shopify!.examples).toEqual({ rank_bucket: 1000, domains: ["store-d.co.uk"] });
    expect(shopify!.cwv_mobile.sites_with_data).toBeLessThanOrEqual(5);
    expect(shopify!.used_alongside.length).toBeGreaterThan(0);
    expect(shopify!.top_tlds[0]).toEqual({ tld: "com", sites: 3 });
    expect(shopify!.share_of_all_sites).toBeGreaterThan(0);
  });

  it("lists every technology whose name contains the term, exact slug first", async () => {
    const reports = await technologyReports(snapshot, "shopify");
    expect(reports.map((r) => r.slug)).toEqual(["shopify", "shopify-pay"]);
    expect(await technologyReports(snapshot, "nothing-like-this")).toEqual([]);
  });
});
