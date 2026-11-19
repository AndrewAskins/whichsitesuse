import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Snapshot } from "../src/data/snapshot.js";
import { SEO_RULES, type SeoRules } from "../src/seo/config.js";
import { buildSeoDataset, type SeoDataset } from "../src/seo/dataset.js";
import { exportSite } from "../src/seo/export.js";
import {
  PagePlan,
  rankLabels,
  renderCategoryIndex,
  renderCategoryPage,
  renderSitemap,
  renderTechPage,
} from "../src/seo/pages.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

// The fixture is tiny, so every threshold is lowered; production uses SEO_RULES as is.
const rules: SeoRules = {
  ...SEO_RULES,
  minPageSites: 1,
  minIndexSites: 3,
  minIndexTopSites: 1,
  minCategoryTechs: 1,
  coUsageSampleEvery: 1,
  coUsageMinSample: 1,
  coUsageMinLift: 0,
  coUsageMinPair: 1,
  cwvMinTested: 1,
};

let data: SeoDataset;
let plan: PagePlan;
let server: Server;
let base: string;

beforeAll(async () => {
  const snapshot = await Snapshot.open(await buildFixtureSnapshot(QUERY_FIXTURE_ROWS), { serveHttpArchive: true });
  data = await buildSeoDataset(snapshot, { rules, now: new Date("2026-11-20T00:00:00Z") });
  snapshot.close();
  plan = new PagePlan(data, rules);
  const app = createApp({ config: testConfig(), getSnapshot: () => null, getSeoPlan: () => plan });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("PagePlan", () => {
  it("indexes technologies over the bar and keeps the rest noindex", () => {
    expect(plan.indexedTech.has("shopify")).toBe(true); // 5 sites
    expect(plan.tech.has("doppler")).toBe(true);
    expect(plan.indexedTech.has("doppler")).toBe(false); // 1 site
  });

  it("caps indexing to the biggest technologies", () => {
    const capped = new PagePlan(data, { ...rules, maxIndexedTechPages: 1 });
    expect([...capped.indexedTech]).toEqual(["shopify"]);
  });

  it("drops technologies under the page bar entirely", () => {
    const strict = new PagePlan(data, { ...rules, minPageSites: 2 });
    expect(strict.tech.has("doppler")).toBe(false);
    expect(renderTechPage(strict, "doppler")).toBeNull();
  });

  it("leaves hand-written pages out of the sitemap", () => {
    const xml = renderSitemap(plan);
    expect(xml).not.toContain("/companies-using/shopify/");
    expect(xml).toContain("https://whichsitesuse.com/categories/");
    expect(xml).not.toContain("/companies-using/doppler/");
  });

  it("labels rank buckets from the data", () => {
    const labels = rankLabels([{ rank_bucket: 1000, sites: 1 }, { rank_bucket: 5000, sites: 1 }, { rank_bucket: null, sites: 1 }]);
    expect(labels.get(1000)).toBe("Top 1k");
    expect(labels.get(5000)).toBe("1k to 5k");
    expect(labels.get(null)).toBe("No CrUX rank");
  });
});

describe("technology page", () => {
  it("answers the question with real counts and the shared header", () => {
    const html = renderTechPage(plan, "shopify")!.html;
    expect(html).toContain("<h1>Which sites use Shopify?</h1>");
    expect(html).toContain("5 of the 8 websites in HTTP Archive's October 2026 crawl run Shopify.");
    expect(html).toContain('<link rel="canonical" href="https://whichsitesuse.com/companies-using/shopify/">');
    expect(html).toContain('content="index,follow"');
    expect(html).toContain('class="site-header"');
    expect(html).toContain("store-d.co.uk");
    expect(html).toContain("/v1/sites?technologies=shopify");
  });

  it("marks small technologies noindex", () => {
    expect(renderTechPage(plan, "doppler")!.html).toContain('content="noindex,follow"');
  });

  it("shows the disambiguation note", () => {
    expect(renderTechPage(plan, "doppler")!.html).toContain("not the secrets manager");
  });

  it("hides sections without enough data", () => {
    const html = renderTechPage(new PagePlan(data, { ...rules, cwvMinTested: 1000 }), "shopify")!.html;
    expect(html).not.toContain("Core Web Vitals on Shopify sites");
    expect(renderTechPage(plan, "shopify")!.html).toContain("Core Web Vitals on Shopify sites");
  });

  it("escapes names from the data", () => {
    const evil: SeoDataset = {
      ...data,
      technologies: data.technologies.map((t) => (t.slug === "klaviyo" ? { ...t, name: '<script>alert("x")</script>' } : t)),
    };
    const html = renderTechPage(new PagePlan(evil, rules), "klaviyo")!.html;
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("says how the count changed when last month is known", () => {
    const withPrev: SeoDataset = { ...data, technologies: data.technologies.map((t) => ({ ...t, previous_sites: t.slug === "shopify" ? 4 : null })) };
    expect(renderTechPage(new PagePlan(withPrev, rules), "shopify")!.html).toContain("That's 1 more than September 2026 (+25%).");
  });
});

describe("category pages", () => {
  it("ranks a category's technologies", () => {
    const html = renderCategoryPage(plan, "email-marketing")!.html;
    expect(html).toContain("<h1>Most popular email marketing technologies</h1>");
    expect(html.indexOf("/companies-using/klaviyo/")).toBeLessThan(html.indexOf("/companies-using/doppler/"));
  });

  it("lists every category on the index", () => {
    const html = renderCategoryIndex(plan).html;
    expect(html).toContain('href="/categories/email-marketing/"');
  });

  it("has no page for a category with one technology", () => {
    expect(renderCategoryPage(plan, "ecommerce")).toBeNull();
  });
});

describe("routes", () => {
  it("serves a technology page", async () => {
    const res = await fetch(`${base}/companies-using/doppler/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, follow");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("redirects to the trailing slash", async () => {
    const res = await fetch(`${base}/companies-using/klaviyo`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/companies-using/klaviyo/");
  });

  it("404s an unknown technology", async () => {
    expect((await fetch(`${base}/companies-using/nope/`)).status).toBe(404);
  });

  it("serves the sitemap and keeps crawlers off the API host's copies", async () => {
    expect(await (await fetch(`${base}/sitemaps/technologies.xml`)).text()).toContain("<urlset");
    expect(await (await fetch(`${base}/robots.txt`)).text()).toContain("Disallow: /companies-using/");
  });

  it("404s everything before a dataset is loaded", async () => {
    const app = createApp({ config: testConfig(), getSnapshot: () => null });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/categories/`);
    s.close();
    expect(res.status).toBe(404);
  });
});

describe("static export", () => {
  it("writes every page and never overwrites a hand-written one", async () => {
    const site = await mkdtemp(join(tmpdir(), "wsu-site-"));
    const out = await mkdtemp(join(tmpdir(), "wsu-out-"));
    await mkdir(join(site, "companies-using", "shopify"), { recursive: true });
    await writeFile(join(site, "companies-using", "shopify", "index.html"), "hand-written");
    const written = await exportSite(plan, site, out);
    expect(written).toBe(plan.tech.size - 1 + plan.category.size + 1);
    expect(await readFile(join(out, "companies-using", "shopify", "index.html"), "utf8")).toBe("hand-written");
    expect(existsSync(join(out, "companies-using", "klaviyo", "index.html"))).toBe(true);
    expect(existsSync(join(out, "sitemaps", "technologies.xml"))).toBe(true);
  });
});
