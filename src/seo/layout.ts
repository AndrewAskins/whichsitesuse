import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_ORIGIN } from "./config.js";

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

/** JSON for a <script type="application/ld+json"> block, safe against "</script>". */
export const jsonLd = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export interface Crumb {
  name: string;
  path?: string;
}

export interface PageShell {
  path: string;
  title: string;
  description: string;
  indexable: boolean;
  crumbs: Crumb[];
  structuredData?: unknown[];
  /** Inside the hero, after the breadcrumbs. */
  hero: string;
  /** The sections after the hero. */
  sections: string;
}

export const absolute = (path: string) => `${SITE_ORIGIN}${path}`;

export function renderShell(page: PageShell): string {
  const p = loadPartials();
  const url = absolute(page.path);
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: page.crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: absolute(c.path) } : {}),
    })),
  };
  const ld = [breadcrumbs, ...(page.structuredData ?? [])];
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
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.description)}">
  <meta name="twitter:card" content="summary">

  <!-- @partial head -->
${p.head ?? ""}  <!-- @end head -->
  <link rel="stylesheet" href="/seo.css">

  <script type="application/ld+json">${jsonLd(ld)}</script>
</head>
<body>
  <!-- @partial header -->
${p.header ?? ""}  <!-- @end header -->

  <main>
    <section class="page-hero">
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
