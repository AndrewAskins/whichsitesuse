import { Router, type Response } from "express";
import { log } from "../log.js";
import { TECH_ICON_BASE } from "../seo/catalog.js";
import type { SeoTechnology } from "../seo/dataset.js";
import { monthLabel, techHeading, type PagePlan } from "../seo/pages.js";
import { ogPng, type OgCard } from "./card.js";

/**
 * Open Graph images for the generated pages, rendered on request and cached:
 *   /og/companies-using.png, /og/companies-using/<slug>.png, /og/categories.png, /og/categories/<slug>.png
 * Pages point their og:image here on the API host, so the static site needs no rewrite for them.
 */
const fmt = new Intl.NumberFormat("en-US");

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export function ogRouter(getPlan: () => PagePlan | null, fetchImpl: typeof fetch = fetch): Router {
  const router = Router({ strict: true });
  const images = new Lru<Buffer>(400);
  const icons = new Lru<Buffer | null>(1000);

  async function icon(t: SeoTechnology): Promise<Buffer | null> {
    const file = t.icon ?? `${t.name}.png`;
    const hit = icons.get(file);
    if (hit !== undefined) return hit;
    let buf: Buffer | null = null;
    try {
      const res = await fetchImpl(TECH_ICON_BASE + encodeURIComponent(file), { signal: AbortSignal.timeout(3000) });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/png")) buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      log.debug({ err, file }, "og icon fetch failed");
    }
    icons.set(file, buf);
    return buf;
  }

  const send = async (res: Response, key: string, make: () => Promise<OgCard | null>) => {
    const plan = getPlan();
    if (!plan) return res.status(404).end();
    const cacheKey = `${plan.data.crawl_date}:${key}`;
    let png = images.get(cacheKey);
    if (!png) {
      const card = await make();
      if (!card) return res.status(404).end();
      png = ogPng(card);
      images.set(cacheKey, png);
    }
    res.type("png").set("Cache-Control", "public, max-age=86400").send(png);
  };

  const footnote = (plan: PagePlan) => `HTTP Archive, ${monthLabel(plan.data.crawl_date)}`;

  router.get("/og/companies-using/:file", (req, res) => {
    const slug = req.params.file.replace(/\.png$/, "").toLowerCase();
    return send(res, `t:${slug}`, async () => {
      const plan = getPlan()!;
      const t = plan.tech.get(slug);
      if (!t) return null;
      return {
        eyebrow: "Companies using",
        title: techHeading(slug, t.name),
        stat: fmt.format(t.sites),
        statLabel: `websites run ${t.name}`,
        footnote: footnote(plan),
        icon: await icon(t),
      };
    });
  });
  router.get("/og/categories/:file", (req, res) => {
    const slug = req.params.file.replace(/\.png$/, "").toLowerCase();
    return send(res, `c:${slug}`, async () => {
      const plan = getPlan()!;
      const c = plan.category.get(slug);
      if (!c) return null;
      const leader = plan.tech.get(c.technologies[0]!);
      return {
        eyebrow: "Category",
        title: `Most popular ${c.name.toLowerCase()} technologies`,
        stat: `~${fmt.format(c.sites_estimate)}`,
        statLabel: `websites run one${leader ? `. ${leader.name} leads.` : ""}`,
        footnote: footnote(plan),
        icon: leader ? await icon(leader) : null,
      };
    });
  });
  router.get("/og/companies-using.png", (_req, res) =>
    send(res, "hub", async () => {
      const plan = getPlan()!;
      return {
        eyebrow: "Companies using",
        title: "Find companies by technology",
        stat: fmt.format(plan.tech.size),
        statLabel: "technologies, each with the sites that run it",
        footnote: footnote(plan),
      };
    }),
  );
  router.get("/og/categories.png", (_req, res) =>
    send(res, "cats", async () => {
      const plan = getPlan()!;
      return {
        eyebrow: "Categories",
        title: "Technology categories and market share",
        stat: fmt.format(plan.category.size),
        statLabel: "categories ranked by number of websites",
        footnote: footnote(plan),
      };
    }),
  );
  return router;
}
