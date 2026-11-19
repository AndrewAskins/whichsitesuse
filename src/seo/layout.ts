import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { absolute, breadcrumbList, graph, ldJson, webPage, type Crumb, type Node } from "./schema.js";

/** The marketing site's shared head, header and footer (scripts/site-partials, one source for every page). */
const PARTIAL_DIR = fileURLToPath(new URL("../../scripts/site-partials/", import.meta.url));

let partials: Record<string, string> | null = null;
export function loadPartials(): Record<string, string> {
  if (!partials) {
    partials = Object.fromEntries(
      readdirSync(PARTIAL_DIR)
        .filter((f) => f.endsWith(".html"))
        .map((f) => [f.replace(/\.html$/, ""), readFileSync(join(PARTIAL_DIR, f), "utf8")]),
    );
  }
  return partials;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escapes text for HTML. Every value from the dataset goes through this. */
export const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export { ldJson as jsonLd } from "./schema.js";

export type { Crumb } from "./schema.js";

export interface PageShell {
  path: string;
  title: string;
  description: string;
  indexable: boolean;
  crumbs: Crumb[];
  /** JSON-LD nodes besides the breadcrumbs and the WebPage, which every page gets. */
  structuredData?: Node[];
  pageType?: "WebPage" | "CollectionPage";
  /** Absolute URL of the page's 1200x630 Open Graph image. */
  ogImage: string;
  dateModified?: string;
  /** Inside the hero, after the breadcrumbs. */
  hero: string;
  /** The sections after the hero. */
  sections: string;
}

export { absolute };

export function renderShell(page: PageShell): string {
  const p = loadPartials();
  const url = absolute(page.path);
  const ld = graph([
    webPage({ path: page.path, name: page.title.replace(/ \| WhichSitesUse$/, ""), description: page.description, dateModified: page.dateModified, image: page.ogImage, type: page.pageType }),
    breadcrumbList(page.crumbs),
    ...(page.structuredData ?? []),
  ]);
  const crumbs = page.crumbs
    .map((c) => (c.path ? `<a href="${esc(c.path)}">${esc(c.name)}</a>` : esc(c.name)))
    .join(" / ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.description)}">
  <link rel="canonical" href="${esc(url)}">
  <meta name="robots" content="${page.indexable ? "index,follow" : "noindex,follow"}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WhichSitesUse">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.description)}">
  <meta property="og:image" content="${esc(page.ogImage)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(page.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(page.title)}">
  <meta name="twitter:description" content="${esc(page.description)}">
  <meta name="twitter:image" content="${esc(page.ogImage)}">

  <!-- @partial head -->
${p.head ?? ""}  <!-- @end head -->
  <link rel="stylesheet" href="/seo.css">

  <script type="application/ld+json">${ldJson(ld)}</script>
</head>
<body>
  <!-- @partial header -->
${p.header ?? ""}  <!-- @end header -->

  <main>
    <section class="page-hero seo-hero">
      <div class="wrap">
        <p class="crumbs">${crumbs}</p>
${page.hero}
      </div>
    </section>
${page.sections}
  </main>

  <!-- @partial footer -->
${p.footer ?? ""}  <!-- @end footer -->

  <script>document.getElementById("year").textContent = String(new Date().getFullYear());</script>
</body>
</html>
`;
}
