import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ogPng, type OgCard } from "../og/card.js";
import { article, breadcrumbList, faqPage, graph, ldJson, softwareApplication, webPage, type Crumb, type Node } from "../seo/schema.js";
import { SITE_ORIGIN } from "../seo/config.js";

/**
 * Head metadata for the hand-written pages in site/: title, description, canonical, Open Graph,
 * Twitter card and one JSON-LD graph, written between <!-- @meta --> and <!-- @end meta -->.
 * Each page also gets its own share image in site/og/, drawn with the shared card template.
 * FAQPage schema is read from the page's visible FAQ, so the two can't drift apart.
 *
 *   npm run site:meta            rewrite the head blocks and render the share images
 *   npm run site:meta -- --check exit 1 if a head block is out of date (images aren't compared)
 */

type Kind = "home" | "doc" | "article" | "page";

export interface PageMeta {
  /** URL path, e.g. "/docs/api/". The file is site/<path>index.html. */
  path: string;
  title: string;
  description: string;
  /** Shorter title and description for social cards; default to title (without the suffix) and description. */
  ogTitle?: string;
  ogDescription?: string;
  kind: Kind;
  crumbs?: Crumb[];
  card: Omit<OgCard, "icon">;
  /** Topics for Article schema. */
  about?: string[];
}

export const DATE_MODIFIED = "2026-11-19";
const OG_DIR = "og";
const HOME: Crumb = { name: "Home", path: "/" };
const DOCS: Crumb = { name: "Docs", path: "/docs/" };
const API: Crumb = { name: "API reference", path: "/docs/api/" };

const doc = (path: string, title: string, description: string, card: PageMeta["card"], crumbs: Crumb[], ogTitle?: string): PageMeta => ({
  path, title, description, kind: "doc", card, crumbs, ...(ogTitle ? { ogTitle } : {}),
});
const docsCard = (eyebrow: string, title: string, stat?: string, statLabel?: string): PageMeta["card"] => ({
  eyebrow, title, ...(stat ? { stat, statLabel } : {}), footnote: "whichsitesuse.com/docs",
});

export const PAGES: PageMeta[] = [
  {
    path: "/",
    title: "What Is This Website Built With? Free Lookup | WhichSitesUse",
    description: "What is this website built with? Look up any domain free to see its CMS, frameworks, analytics and Core Web Vitals, or list sites by technology over MCP and API.",
    ogTitle: "WhichSitesUse: which sites use any technology",
    ogDescription: "Look up any domain to see its stack, or list the sites that use a technology, over MCP and a REST API.",
    kind: "home",
    card: { eyebrow: "Website technology lookup", title: "See any website's tech stack", stat: "15M", statLabel: "sites in each monthly crawl" },
  },
  {
    path: "/builtwith-alternative/",
    title: "BuiltWith Alternative for Agents, from $49 | WhichSitesUse",
    description: "A BuiltWith alternative priced per site, from $49 a month. Compare plans, data and agent access, including where BuiltWith is still the better pick.",
    ogTitle: "A cheaper BuiltWith alternative, built for agents",
    ogDescription: "WhichSitesUse and BuiltWith compared on price, data, coverage and agent access, with the cases where BuiltWith is the better buy.",
    kind: "page",
    crumbs: [HOME, { name: "BuiltWith alternative" }],
    card: { eyebrow: "Compare", title: "A BuiltWith alternative built for agents", stat: "$49", statLabel: "a month for 15,000 credits" },
  },
  {
    path: "/wappalyzer-alternative/",
    title: "Wappalyzer Alternative for Agents, from $49 | WhichSitesUse",
    description: "A Wappalyzer alternative built on the same open-source rules, priced per site from $49 a month. See how plans, data and agent access compare.",
    ogTitle: "A Wappalyzer alternative on the same open-source rules",
    ogDescription: "WhichSitesUse and Wappalyzer compared on price, detection rules, data and agent access, with the cases where Wappalyzer is the better buy.",
    kind: "page",
    crumbs: [HOME, { name: "Wappalyzer alternative" }],
    card: { eyebrow: "Compare", title: "A Wappalyzer alternative on the same open-source rules", stat: "$49", statLabel: "a month for 15,000 credits" },
  },
  {
    path: "/technographics/",
    title: "Technographics: Sources, Uses and Limits | WhichSitesUse",
    description: "What technographic data is, where it comes from, what it misses, and how sales and agency teams turn it into prospect lists, with counts from 15M sites.",
    ogTitle: "Technographics: what the data is and how to use it",
    ogDescription: "Where technographic data comes from, what it can't see, and how to turn it into a prospect list, with real counts from HTTP Archive's November 2026 crawl.",
    kind: "article",
    about: ["Technographic data", "Technographic segmentation", "B2B prospecting"],
    crumbs: [HOME, { name: "Technographics guide" }],
    card: { eyebrow: "Guide", title: "Technographics: what the data is and how to use it" },
  },
  {
    path: "/privacy/",
    title: "Privacy Policy | WhichSitesUse",
    description: "What WhichSitesUse collects when you sign up and use the API, why, who processes it, how long we keep it, and how to ask for a copy or deletion.",
    ogTitle: "WhichSitesUse privacy policy",
    ogDescription: "What we collect, why, who processes it, and how to ask for a copy or deletion.",
    kind: "page",
    crumbs: [HOME, { name: "Privacy policy" }],
    card: { eyebrow: "Legal", title: "Privacy policy" },
  },
  {
    path: "/terms/",
    title: "Terms of Service | WhichSitesUse",
    description: "The terms for using WhichSitesUse: accounts, free credits, plans and top-ups, API keys and agents, acceptable use, the data's limits, and liability.",
    ogTitle: "WhichSitesUse terms of service",
    ogDescription: "Accounts, credits, API keys and agents, acceptable use, the data's limits, and liability.",
    kind: "page",
    crumbs: [HOME, { name: "Terms of service" }],
    card: { eyebrow: "Legal", title: "Terms of service" },
  },
  doc("/docs/", "API and MCP Quickstart | WhichSitesUse Docs",
    "Make a free call to the WhichSitesUse API, then create an account and an API key for MCP clients, paid searches and domain lookups.",
    docsCard("Docs", "API and MCP quickstart", "367", "Shopify sites in the top 100k fail LCP"), [HOME, { name: "Docs" }], "WhichSitesUse API and MCP quickstart"),
  doc("/docs/connect/", "Connect the MCP Server to Claude, ChatGPT or Cursor | WhichSitesUse",
    "Connect the WhichSitesUse MCP server to Claude, ChatGPT, Claude Code, Cursor or any client that supports remote Streamable HTTP servers.",
    docsCard("Docs", "Connect an MCP client"), [HOME, DOCS, { name: "Connect an MCP client" }], "Connect WhichSitesUse to Claude, ChatGPT or Cursor"),
  doc("/docs/clay/", "Tech Stack Enrichment in Clay | WhichSitesUse Docs",
    "Add each account's tech stack to a Clay table, or import every site that runs a technology, with Clay's HTTP API column and your WhichSitesUse key.",
    docsCard("Integrations", "Use WhichSitesUse in Clay", "2 credits", "per row for a full tech stack"), [HOME, DOCS, { name: "Clay" }], "Add tech stack data to Clay tables with WhichSitesUse"),
  doc("/docs/api/", "API Requests and Responses | WhichSitesUse Docs",
    "How WhichSitesUse requests work over MCP and REST: the six operations and their costs, how inputs are passed, and the response envelope.",
    docsCard("API reference", "Requests and responses"), [HOME, DOCS, { name: "API reference" }]),
  doc("/docs/api/filters/", "Site Filters for count_sites and search_sites | WhichSitesUse",
    "The filters count_sites and search_sites share: technologies, categories, versions, popularity rank, top-level domain, Core Web Vitals and device.",
    docsCard("API reference", "Site filters"), [HOME, DOCS, API, { name: "Site filters" }]),
  doc("/docs/api/find-technologies/", "find_technologies: Look Up Technology Slugs | WhichSitesUse",
    "Look up technology slugs by name or category with find_technologies. Free, and on REST it needs no API key.",
    docsCard("API reference", "find_technologies", "Free", "and no key needed on REST"), [HOME, DOCS, API, { name: "find_technologies" }]),
  doc("/docs/api/count-sites/", "count_sites: Count Sites by Technology | WhichSitesUse",
    "Count the sites that match a filter and see what the full list would cost with count_sites. Free, and on REST it needs no API key.",
    docsCard("API reference", "count_sites", "Free", "and no key needed on REST"), [HOME, DOCS, API, { name: "count_sites" }]),
  doc("/docs/api/search-sites/", "search_sites: List Sites by Technology | WhichSitesUse",
    "List the sites that match a filter with search_sites, with matched technologies and Core Web Vitals for each. 1 credit per site returned.",
    docsCard("API reference", "search_sites", "1 credit", "per site returned"), [HOME, DOCS, API, { name: "search_sites" }]),
  doc("/docs/api/lookup-domain/", "lookup_domain: Website Tech Stack Lookup | WhichSitesUse",
    "Get one domain's full technology stack and Core Web Vitals with lookup_domain. 2 credits, and free when the domain isn't covered.",
    docsCard("API reference", "lookup_domain", "2 credits", "per domain, free when not covered"), [HOME, DOCS, API, { name: "lookup_domain" }]),
  doc("/docs/api/get-balance/", "get_balance: Check Your Credits | WhichSitesUse",
    "Check the credits left, plan, renewal date and the key's monthly cap with get_balance. Free.",
    docsCard("API reference", "get_balance", "Free"), [HOME, DOCS, API, { name: "get_balance" }]),
  doc("/docs/api/buy-credits/", "buy_credits: Create a Checkout Link | WhichSitesUse",
    "Create a Stripe checkout link for a top-up or a monthly plan with buy_credits, so an agent can hand the payment to a person.",
    docsCard("API reference", "buy_credits", "Free", "to call, a person pays"), [HOME, DOCS, API, { name: "buy_credits" }]),
  doc("/docs/credits/", "Credits, Plans and Billing | WhichSitesUse Docs",
    "What WhichSitesUse calls cost, the monthly plans and top-ups, how credits reset and get spent, and what happens when they run out.",
    docsCard("Docs", "Credits and billing", "$49", "a month for 15,000 credits"), [HOME, DOCS, { name: "Credits and billing" }]),
  doc("/docs/errors/", "API Errors and Rate Limits | WhichSitesUse Docs",
    "WhichSitesUse error codes and HTTP statuses, plus the per-minute rate limits and trial limits for keys, accounts and keyless calls.",
    docsCard("Docs", "Errors and limits"), [HOME, DOCS, { name: "Errors and limits" }]),
  doc("/docs/data/", "Data Freshness and Coverage | WhichSitesUse Docs",
    "Where WhichSitesUse data comes from, how fresh it is, and which sites and tools it can't see.",
    docsCard("Docs", "Data freshness and coverage"), [HOME, DOCS, { name: "Data and coverage" }]),
];

/** The card a share falls back on when a page has none of its own. */
export const DEFAULT_CARD: PageMeta["card"] = { eyebrow: "Website technology lookup", title: "Which sites use any technology" };

const siteDir = fileURLToPath(new URL("../../site/", import.meta.url));
export const pageFile = (p: PageMeta) => join(siteDir, p.path.slice(1), "index.html");
export const imageName = (p: PageMeta) => (p.path === "/" ? "home" : p.path.replace(/^\/|\/$/g, "").replace(/\//g, "-")) + ".png";
export const imageUrl = (p: PageMeta) => `${SITE_ORIGIN}/${OG_DIR}/${imageName(p)}`;

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " })[e]!);
const stripSuffix = (t: string) => t.replace(/\s*\|\s*WhichSitesUse( Docs)?$/, "");

/** Questions and answers from the page's visible FAQ: <details><summary><h3>Q</h3></summary><p>A</p>...</details>. */
export function visibleFaq(html: string): { q: string; a: string }[] {
  const list = /<div class="faq-list">([\s\S]*?)\n\s*<\/div>/.exec(html)?.[1];
  if (!list) return [];
  return [...list.matchAll(/<details>\s*<summary><h3>([\s\S]*?)<\/h3><\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({
    q: decode(m[1]!.replace(/<[^>]+>/g, "").trim()),
    a: decode(m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
  }));
}

const PLANS = [
  { name: "Starter", price: "49", description: "15,000 credits a month", recurring: true },
  { name: "Growth", price: "149", description: "60,000 credits a month", recurring: true },
  { name: "Pro", price: "399", description: "200,000 credits a month", recurring: true },
  { name: "Scale", price: "999", description: "750,000 credits a month", recurring: true },
  { name: "Top-up", price: "15", description: "1,000 credits that last 12 months" },
];

export function schemaFor(p: PageMeta, html: string): Node {
  const image = imageUrl(p);
  const name = stripSuffix(p.title);
  const nodes: Node[] = [webPage({ path: p.path, name, description: p.description, dateModified: DATE_MODIFIED, image })];
  if (p.kind === "home") nodes.push(softwareApplication({ path: "/", description: p.ogDescription ?? p.description, offers: PLANS }));
  if (p.kind === "doc" || p.kind === "article") {
    nodes.push(article({
      path: p.path, headline: p.ogTitle ?? name, description: p.description, dateModified: DATE_MODIFIED, image,
      type: p.kind === "doc" ? "TechArticle" : "Article", ...(p.about ? { about: p.about } : {}),
    }));
  }
  if (p.crumbs) nodes.push(breadcrumbList(p.crumbs));
  const faq = visibleFaq(html);
  if (faq.length) nodes.push(faqPage(faq));
  return graph(nodes);
}

export function metaBlock(p: PageMeta, html: string): string {
  const ogTitle = p.ogTitle ?? stripSuffix(p.title);
  const ogDescription = p.ogDescription ?? p.description;
  const url = `${SITE_ORIGIN}${p.path}`;
  const image = imageUrl(p);
  const alt = `${p.card.title}, on a WhichSitesUse card`;
  return [
    "  <!-- @meta -->",
    `  <title>${text(p.title)}</title>`,
    `  <meta name="description" content="${attr(p.description)}">`,
    `  <link rel="canonical" href="${url}">`,
    `  <meta property="og:type" content="${p.kind === "home" ? "website" : "article"}">`,
    `  <meta property="og:site_name" content="WhichSitesUse">`,
    `  <meta property="og:url" content="${url}">`,
    `  <meta property="og:title" content="${attr(ogTitle)}">`,
    `  <meta property="og:description" content="${attr(ogDescription)}">`,
    `  <meta property="og:image" content="${image}">`,
    `  <meta property="og:image:width" content="1200">`,
    `  <meta property="og:image:height" content="630">`,
    `  <meta property="og:image:alt" content="${attr(alt)}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    `  <meta name="twitter:title" content="${attr(ogTitle)}">`,
    `  <meta name="twitter:description" content="${attr(ogDescription)}">`,
    `  <meta name="twitter:image" content="${image}">`,
    `  <script type="application/ld+json">${ldJson(schemaFor(p, html))}</script>`,
    "  <!-- @end meta -->",
  ].join("\n");
}

const BLOCK = /  <!-- @meta -->\n[\s\S]*?  <!-- @end meta -->/;
const OLD_TAGS = /^ *(<title>.*<\/title>|<meta name="description"[^>]*>|<link rel="canonical"[^>]*>|<meta (property="og:|name="twitter:)[^>]*>)\n/gm;
const OLD_LD = /\n? *<script type="application\/ld\+json">[\s\S]*?<\/script>\n/g;

/** The page with its head block written (or rewritten) from PAGES. */
export function applyMeta(p: PageMeta, html: string): string {
  if (BLOCK.test(html)) return html.replace(BLOCK, () => metaBlock(p, html));
  const cleaned = html.replace(OLD_LD, "\n").replace(OLD_TAGS, "");
  return cleaned.replace(/( *<meta name="viewport"[^>]*>\n)\n*/, (m, viewport: string) => `${viewport}${metaBlock(p, cleaned)}\n\n`);
}

export async function renderImages(): Promise<string[]> {
  const out = join(siteDir, OG_DIR);
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const [name, card] of [...PAGES.map((p) => [imageName(p), p.card] as const), ["default.png", DEFAULT_CARD] as const]) {
    await writeFile(join(out, name), ogPng(card));
    written.push(`${OG_DIR}/${name}`);
  }
  return written;
}

/** Pages whose head block is missing or out of date. */
export function stalePages(): string[] {
  return PAGES.filter((p) => {
    const html = readFileSync(pageFile(p), "utf8");
    return applyMeta(p, html) !== html;
  }).map((p) => p.path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const stale = stalePages();
    const missing = PAGES.filter((p) => !existsSync(join(siteDir, OG_DIR, imageName(p)))).map((p) => p.path);
    if (stale.length || missing.length) {
      console.error(`Head metadata is out of date for: ${[...stale, ...missing].join(", ")}\nRun: npm run site:meta`);
      process.exit(1);
    }
    console.log("Head metadata is in sync.");
  } else {
    for (const p of PAGES) {
      const file = pageFile(p);
      await mkdir(dirname(file), { recursive: true });
      const html = readFileSync(file, "utf8");
      writeFileSync(file, applyMeta(p, html));
    }
    const images = await renderImages();
    console.log(`Wrote ${PAGES.length} head blocks and ${images.length} share images.`);
  }
}
