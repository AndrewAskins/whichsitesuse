import { Router, type Response } from "express";
import type { PagePlan, RenderedPage } from "./pages.js";
import { renderCategoryIndex, renderCategoryPage, renderSitemap, renderTechPage } from "./pages.js";

/**
 * The programmatic pages. whichsitesuse.com serves them through Render rewrites
 * (/companies-using/*, /categories/*, /sitemaps/*), so every canonical URL is on
 * whichsitesuse.com; robots.txt on the API host keeps crawlers off these copies.
 */
export function seoRouter(getPlan: () => PagePlan | null): Router {
  // strict: "/categories" and "/categories/" are different routes here.
  const router = Router({ strict: true });
  const send = (res: Response, page: RenderedPage | null) => {
    if (!page) return notFound(res);
    res
      .status(200)
      .type("html")
      .set("Cache-Control", "public, max-age=3600")
      .set("X-Robots-Tag", page.indexable ? "index, follow" : "noindex, follow")
      .send(page.html);
  };
  const notFound = (res: Response) =>
    res.status(404).type("html").set("Cache-Control", "public, max-age=600").send("<!doctype html><title>Not found</title><p>No page here. <a href=\"https://whichsitesuse.com/\">WhichSitesUse</a></p>");
  // Pages need a trailing slash, like the static site's folders.
  const slash = (path: string, res: Response) => res.redirect(301, `${path}/`);

  router.get("/companies-using/:slug", (req, res) => slash(req.path, res));
  router.get("/companies-using/:slug/", (req, res) => {
    const plan = getPlan();
    send(res, plan ? renderTechPage(plan, req.params.slug.toLowerCase()) : null);
  });
  router.get("/categories", (_req, res) => slash("/categories", res));
  router.get("/categories/", (_req, res) => {
    const plan = getPlan();
    send(res, plan ? renderCategoryIndex(plan) : null);
  });
  router.get("/categories/:slug", (req, res) => slash(req.path, res));
  router.get("/categories/:slug/", (req, res) => {
    const plan = getPlan();
    send(res, plan ? renderCategoryPage(plan, req.params.slug.toLowerCase()) : null);
  });
  router.get("/sitemaps/technologies.xml", (_req, res) => {
    const plan = getPlan();
    if (!plan) return res.status(404).end();
    res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(renderSitemap(plan));
  });
  // Crawlers reach these pages through whichsitesuse.com only.
  router.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /companies-using/\nDisallow: /categories/\nDisallow: /sitemaps/\n");
  });
  return router;
}
