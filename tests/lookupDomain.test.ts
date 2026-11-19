import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { lookupDomain, normalizeDomain } from "../src/operations/lookupDomain.js";
import { OperationError, type OperationContext } from "../src/operations/types.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

let ctx: OperationContext;
let killed: OperationContext;
beforeAll(async () => {
  const dir = await buildFixtureSnapshot(QUERY_FIXTURE_ROWS);
  ctx = { config: testConfig(), snapshot: await Snapshot.open(dir, { serveHttpArchive: true }) };
  killed = { config: testConfig(), snapshot: await Snapshot.open(dir, { serveHttpArchive: false }) };
});
afterAll(() => {
  ctx.snapshot?.close();
  killed.snapshot?.close();
});

const lookup = (domain: string, c = ctx) => lookupDomain.run(lookupDomain.input.parse({ domain }), c);

describe("normalizeDomain", () => {
  it("keeps the lowercase host without scheme, www, path, port or trailing dot", () => {
    expect(normalizeDomain("Shop-A.com")).toBe("shop-a.com");
    expect(normalizeDomain("https://www.shop-a.com:8443/pricing?x=1#top")).toBe("shop-a.com");
    expect(normalizeDomain("www.store-d.co.uk/")).toBe("store-d.co.uk");
    expect(normalizeDomain("http://user@shop-a.com.")).toBe("shop-a.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
  });
});

describe("lookup_domain", () => {
  it("returns the stack grouped by category, CWV per device, for 2 credits", async () => {
    const { data, credits_used } = await lookup("https://WWW.shop-h.com/products");
    expect(credits_used).toBe(2);
    expect(data).toMatchObject({
      covered: true,
      domain: "shop-h.com",
      root_url: "https://shop-h.com/",
      rank_bucket: 10000,
      tld: "com",
      last_crawl_date: "2026-10-01",
      source: "httparchive",
    });
    if (!data.covered) throw new Error("expected covered");
    expect(data.stack).toEqual([
      {
        category: "Ecommerce",
        technologies: [
          { name: "Shopify", slug: "shopify", version: null, categories: ["Ecommerce"], first_seen: "2026-10-01", last_seen: "2026-10-01", confidence: 0.8 },
        ],
      },
      {
        category: "Payment processors",
        technologies: [
          { name: "Shopify Pay", slug: "shopify-pay", version: null, categories: ["Payment processors"], first_seen: "2026-10-01", last_seen: "2026-10-01", confidence: 1 },
        ],
      },
    ]);
    expect(data.cwv.mobile.lcp).toEqual({ p75: 2600, pass: false });
    expect(data.cwv.mobile.inp).toEqual({ p75: 180, pass: true });
    expect(data.cwv.desktop).toMatchObject({ device: "desktop", cls: { p75: 0.05, pass: true } });
  });

  it("includes versions and every category of a technology", async () => {
    const { data } = await lookup("blog-b.org");
    if (!data.covered) throw new Error("expected covered");
    expect(data.stack[0]?.category).toBe("CMS");
    expect(data.stack[0]?.technologies[0]).toMatchObject({ slug: "wordpress", version: "6.8.1", categories: ["CMS", "Blogs"] });
    expect(data.cwv.desktop.lcp).toEqual({ p75: null, pass: null });
  });

  it("answers covered: false for free when the domain isn't in the snapshot", async () => {
    const { data, credits_used } = await lookup("https://www.Unknown-Site.example/");
    expect(credits_used).toBe(0);
    expect(data).toMatchObject({ covered: false, domain: "unknown-site.example" });
    if (data.covered) throw new Error("expected not covered");
    expect(data.message).toMatch(/Chrome/);
  });

  it("rejects input that isn't a domain", async () => {
    const err = await lookup("hello world").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe("invalid_input");
  });

  it("treats HTTP Archive domains as not covered when the kill switch is off", async () => {
    expect((await lookup("shop-a.com", killed)).data.covered).toBe(false);
    expect((await lookup("shop-a.com", killed)).credits_used).toBe(0);
    const live = await lookup("live-c.io", killed);
    expect(live.data).toMatchObject({ covered: true, source: "live_crawl" });
  });
});
