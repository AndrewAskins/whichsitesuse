import { TECH_ICON_BASE } from "./catalog.js";
import { logoUrl } from "./logos.js";
import { SEO_RULES, type SeoRules } from "./config.js";
import type { RankRow, SeoCategory, SeoDataset, SeoTechnology } from "./dataset.js";
import { absolute, esc, jsonLd, renderShell, type Crumb } from "./layout.js";
import { dataset, faqPage, itemList } from "./schema.js";
import { TECH_PAGE_OVERRIDES } from "./overrides.js";

/**
 * Renders the programmatic pages from the monthly dataset. Each page leads with what
 * the visitor came for (the sites, or the technologies), with logos and key numbers,
 * and keeps the explaining short and below it. Copy is fixed template text; every
 * number and list comes from the data, and a block only shows when its data is there.
 */

export interface RenderedPage {
  html: string;
  indexable: boolean;
}

const API = "https://api.whichsitesuse.com";
const fmt = new Intl.NumberFormat("en-US");
const n = (v: number) => fmt.format(v);
const pctNum = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const pctText = (p: number) => `${p >= 10 ? Math.round(p) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
const pct = (part: number, whole: number) => pctText(pctNum(part, whole));
/** Compact counts for cards: 3.6M, 412k, 8,416. */
const compact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M` : v >= 100_000 ? `${Math.round(v / 1_000)}k` : n(v);

export const monthLabel = (date: string | null) =>
  date ? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "";

const short = (v: number) => (v >= 1_000_000 ? `${v / 1_000_000}M` : v >= 1_000 ? `${v / 1_000}k` : String(v));

/** "Top 1k", "1k to 5k" ... from the buckets the crawl actually has. */
export function rankLabels(rows: RankRow[]): Map<number | null, string> {
  const buckets = rows.map((r) => r.rank_bucket).filter((b): b is number => b !== null).sort((a, b) => a - b);
  const labels = new Map<number | null, string>();
  buckets.forEach((b, i) => labels.set(b, i === 0 ? `Top ${short(b)}` : `${short(buckets[i - 1]!)} to ${short(b)}`));
  labels.set(null, "No CrUX rank");
  return labels;
}

/** Sites in buckets at or above `max` (e.g. the top 10k). */
const within = (rows: RankRow[], max: number) =>
  rows.reduce((sum, r) => (r.rank_bucket !== null && r.rank_bucket <= max ? sum + r.sites : sum), 0);

export const techPath = (slug: string) => `/companies-using/${slug}/`;
export const categoryPath = (slug: string) => `/categories/${slug}/`;
export const HUB_PATH = "/companies-using/";

/** Which pages exist and which are indexable, decided from the data and SEO_RULES. */
export class PagePlan {
  readonly tech = new Map<string, SeoTechnology>();
  readonly category = new Map<string, SeoCategory>();
  readonly indexedTech = new Set<string>();
  readonly indexedCategory = new Set<string>();
  private readonly categoryByName = new Map<string, SeoCategory>();

  constructor(
    readonly data: SeoDataset,
    readonly rules: SeoRules = SEO_RULES,
  ) {
    const byCount = [...data.technologies].sort((a, b) => b.sites - a.sites || a.slug.localeCompare(b.slug));
    for (const t of byCount) {
      if (t.sites < rules.minPageSites) continue;
      this.tech.set(t.slug, t);
      if (
        this.indexedTech.size < rules.maxIndexedTechPages &&
        t.sites >= rules.minIndexSites &&
        t.top_sites.length >= rules.minIndexTopSites
      ) {
        this.indexedTech.add(t.slug);
      }
    }
    for (const c of data.categories) {
      const techs = c.technologies.filter((s) => this.tech.has(s));
      if (techs.length < 2 || !c.slug) continue;
      const cat = { ...c, technologies: techs };
      this.category.set(c.slug, cat);
      this.categoryByName.set(c.name, cat);
      if (techs.filter((s) => this.indexedTech.has(s)).length >= rules.minCategoryTechs) this.indexedCategory.add(c.slug);
    }
  }

  /** The technology's categories that have pages, largest first. */
  categoriesFor(t: SeoTechnology): SeoCategory[] {
    return t.categories
      .map((c) => this.categoryByName.get(c))
      .filter((c): c is SeoCategory => c !== undefined)
      .sort((a, b) => b.sites_estimate - a.sites_estimate);
  }

  sitemapPaths(): string[] {
    return [
      HUB_PATH,
      "/categories/",
      ...[...this.indexedCategory].map(categoryPath),
      ...[...this.indexedTech].map(techPath),
    ];
  }
}

/** Most technologies one tiles request returns. */
export const TILES_MAX = 24;

export interface TechTile {
  slug: string;
  name: string;
  sites: number;
  /** "571k sites", formatted like the directory's cards. */
  sites_label: string;
  category: string | null;
  icon: string | null;
  path: string;
}

/**
 * Live name, icon and site count for a few technologies, in the order asked, for tiles outside
 * the generated pages (the homepage). Slugs without a page are left out.
 */
export function techTiles(plan: PagePlan, slugs: string[]): { crawl_date: string; technologies: TechTile[] } {
  const technologies = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))]
    .slice(0, TILES_MAX)
    .flatMap((slug) => {
      const t = plan.tech.get(slug);
      if (!t) return [];
      return [{
        slug: t.slug,
        name: t.name,
        sites: t.sites,
        sites_label: `${compact(t.sites)} sites`,
        category: plan.categoriesFor(t)[0]?.name ?? null,
        icon: logoUrl(t.slug) ?? (t.icon ? TECH_ICON_BASE + encodeURIComponent(t.icon) : null),
        path: techPath(t.slug),
      }];
    });
  return { crawl_date: plan.data.crawl_date, technologies };
}

// ---------- small pieces ----------

/**
 * A technology's logo over a letter tile, so a missing icon still looks deliberate: our own vector
 * logo where site/logos has one (on a light chip, so dark marks read in dark mode), otherwise
 * HTTP Archive's CDN icon.
 */
export function techIcon(t: Pick<SeoTechnology, "slug" | "name" | "icon">, size: "s" | "m" | "l" = "m"): string {
  const vector = logoUrl(t.slug);
  const src = vector ?? TECH_ICON_BASE + encodeURIComponent(t.icon ?? `${t.name}.png`);
  const letter = esc((t.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase());
  return `<span class="ti ti-${size}${vector ? " ti-logo" : ""}" aria-hidden="true"><span>${letter}</span><img src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
}

/** A site's favicon over a letter tile. */
function siteIcon(domain: string): string {
  const letter = esc((domain.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase());
  return `<span class="ti ti-s" aria-hidden="true"><span>${letter}</span><img src="https://icons.duckduckgo.com/ip3/${esc(encodeURIComponent(domain))}.ico" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}

const bar = (p: number) => `<span class="seo-bar" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0.5, p)).toFixed(1)}%"></span></span>`;

const block = (id: string, heading: string, body: string, aside = "") => `
    <section class="seo-block" id="${id}">
      <div class="wrap">
        <div class="seo-block-head"><h2>${heading}</h2>${aside}</div>
${body}
      </div>
    </section>`;

const stats = (items: { label: string; value: string }[]) => `
        <dl class="seo-stats">
${items.map((s) => `          <div><dt class="label">${esc(s.label)}</dt><dd>${s.value}</dd></div>`).join("\n")}
        </dl>`;

const techCard = (plan: PagePlan, t: SeoTechnology, meta: string) =>
  `<a class="seo-card" href="${techPath(t.slug)}">${techIcon(t)}<span class="seo-card-text"><strong>${esc(t.name)}</strong><span>${meta}</span></span></a>`;

const faq = (items: { q: string; a: string }[]) => ({
  html: `
            <div class="faq-list">
${items.map((i) => `              <details>\n                <summary><h3>${esc(i.q)}</h3></summary>\n                <p>${i.a}</p>\n              </details>`).join("\n")}
            </div>`,
  ld: faqPage(items),
});

function changeSentence(t: SeoTechnology, previousMonth: string): string {
  if (t.previous_sites === null || t.previous_sites === 0) return "";
  const diff = t.sites - t.previous_sites;
  if (diff === 0) return ` That's the same count as ${previousMonth}.`;
  return ` That's ${n(Math.abs(diff))} ${diff > 0 ? "more" : "fewer"} than ${previousMonth} (${diff > 0 ? "+" : "-"}${pct(Math.abs(diff), t.previous_sites)}).`;
}

const previousMonthOf = (crawlDate: string) => {
  const d = new Date(`${crawlDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthLabel(d.toISOString().slice(0, 10));
};

const listCta = (count: number, filter: string, label: string) => `
        <div class="seo-cta">
          <div>
            <h3>Get all ${n(count)} ${esc(label)} as a list</h3>
            <p>Counts are free. A list costs 1 credit per site, and you can cut it down first by popularity, top-level domain, other technologies or Core Web Vitals. The same calls work from Claude or ChatGPT through the MCP server.</p>
            <pre class="config"><code>GET ${API}/v1/counts?${esc(filter)}
GET ${API}/v1/sites?${esc(filter)}&amp;max_rank=100000</code></pre>
          </div>
          <div class="seo-cta-actions"><a class="btn btn-primary" href="${API}/signup">Get 250 free credits</a><a class="btn btn-secondary" href="/docs/">Read the docs</a></div>
        </div>`;

/** A category name inside a sentence: "Ecommerce" becomes "ecommerce", while "CMS", "PaaS" and "A/B" keep their capitals. */
export const lowerName = (name: string) => name.replace(/[A-Za-z][\w/-]*/g, (w) => (/^[A-Z0-9/-]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()));

// ---------- technology page ----------

/** The H1 of a technology page: the researched keyword where there is one, else "Which sites use X?". */
export const techHeading = (slug: string, name: string) => TECH_PAGE_OVERRIDES[slug]?.heading ?? `Which sites use ${name}?`;
const ogImage = (path: string) => `${API}/og${path.replace(/\/$/, "")}.png`;

export function renderTechPage(plan: PagePlan, slug: string): RenderedPage | null {
  const t = plan.tech.get(slug);
  if (!t) return null;
  const { data, rules } = plan;
  const month = monthLabel(data.crawl_date);
  const labels = rankLabels(data.by_rank);
  const total = data.total_sites;
  const name = esc(t.name);
  const path = techPath(slug);
  const indexable = plan.indexedTech.has(slug);
  const cats = plan.categoriesFor(t);
  const main = cats[0];
  const override = TECH_PAGE_OVERRIDES[slug];
  const heading = techHeading(slug, t.name);
  const change = changeSentence(t, previousMonthOf(data.crawl_date));

  const top10k = within(t.by_rank, 10_000);
  const all10k = within(data.by_rank, 10_000);
  const top1m = within(t.by_rank, 1_000_000);
  const all1m = within(data.by_rank, 1_000_000);

  let sections = "";

  // The sites: the reason people land here, so they come first.
  if (t.top_sites.length > 0) {
    sections += block(
      "sites",
      `Top sites using ${name}`,
      `        <ol class="seo-grid seo-sites">
${t.top_sites
  .map(
    (s) =>
      `          <li class="seo-card">${siteIcon(s.domain)}<span class="seo-card-text"><strong>${esc(s.domain)}</strong><span>${esc(labels.get(s.rank_bucket) ?? "")}</span></span></li>`,
  )
  .join("\n")}
        </ol>
        <p class="seo-note">Highest Chrome UX Report popularity bucket first. Sites inside a bucket aren't ranked against each other.</p>`,
      `<a class="btn btn-small btn-secondary" href="#list">Get all ${n(t.sites)}</a>`,
    );
  }

  // Technologies that turn up with it far more often than average.
  const co = (t.co_used ?? []).filter((c) => plan.tech.has(c.slug));
  if (co.length >= 3) {
    sections += block(
      "stack",
      `Often used with ${name}`,
      `        <ul class="seo-grid seo-chips">
${co
  .map((c) => {
    const other = plan.tech.get(c.slug)!;
    return `          <li>${techCard(plan, other, `on ${pctText(c.share * 100)} of ${name} sites`)}</li>`;
  })
  .join("\n")}
        </ul>
        <p class="seo-note">Technologies more common on ${name} sites than across the crawl, estimated from 1 in ${n(data.co_usage_sample_every)} sites.</p>`,
    );
  }

  // Adoption by popularity bucket, as bars.
  let popularity = "";
  if (all10k > 0 && top10k > 0) {
    const ratio = top10k / all10k / (t.sites / total);
    popularity =
      ratio >= 1.25
        ? `More common among popular sites: ${pct(top10k, all10k)} of the top 10k run it, against ${pct(t.sites, total)} of the crawl.`
        : ratio <= 0.8
          ? `Less common among popular sites: ${pct(top10k, all10k)} of the top 10k run it, against ${pct(t.sites, total)} of the crawl.`
          : `About as common in the top 10k (${pct(top10k, all10k)}) as across the crawl (${pct(t.sites, total)}).`;
  }
  const rankRows = data.by_rank.filter((b) => b.rank_bucket !== null);
  const maxShare = Math.max(...rankRows.map((b) => pctNum(t.by_rank.find((r) => r.rank_bucket === b.rank_bucket)?.sites ?? 0, b.sites)), 1);
  sections += block(
    "popularity",
    `${name} by site popularity`,
    `        ${popularity ? `<p class="seo-lead">${popularity}</p>` : ""}
        <div class="seo-bars">
${rankRows
  .map((b) => {
    const mine = t.by_rank.find((r) => r.rank_bucket === b.rank_bucket)?.sites ?? 0;
    const p = pctNum(mine, b.sites);
    return `          <div class="seo-bar-row"><span class="label">${esc(labels.get(b.rank_bucket) ?? "")}</span>${bar((p / maxShare) * 100)}<span class="num">${pctText(p)}</span><span class="num muted">${n(mine)}</span></div>`;
  })
  .join("\n")}
        </div>
        <p class="seo-note">Share of each Chrome UX Report bucket that runs ${name}, with the number of sites.</p>`,
  );

  // The rest of its category.
  if (main) {
    const peers = main.technologies.filter((s) => s !== slug).slice(0, 8);
    if (peers.length > 0) {
      sections += block(
        "alternatives",
        `Other ${esc(lowerName(main.name))}`,
        `        <ul class="seo-grid seo-chips">
${peers.map((s) => `          <li>${techCard(plan, plan.tech.get(s)!, `${compact(plan.tech.get(s)!.sites)} sites`)}</li>`).join("\n")}
        </ul>`,
        `<a class="btn btn-small btn-secondary" href="${categoryPath(main.slug)}">All ${n(main.technologies.length)}</a>`,
      );
    }
  }

  sections += `
    <section class="seo-block" id="list">
      <div class="wrap">${listCta(t.sites, `technologies=${slug}`, `${t.name} sites`)}
      </div>
    </section>`;

  // Short notes below the lists.
  const notes: string[] = [];
  const about = [t.description ? esc(t.description) : "", override?.detection ? esc(override.detection) : ""].filter(Boolean).join(" ");
  if (about) notes.push(`<div><h3>About ${name}</h3><p>${about}</p></div>`);
  if (t.cwv.tested >= rules.cwvMinTested && data.cwv.tested > 0) {
    const mine = t.cwv.good / t.cwv.tested;
    const base = data.cwv.good / data.cwv.tested;
    const compare = mine > base * 1.1 ? "above" : mine < base * 0.9 ? "below" : "close to";
    notes.push(
      `<div><h3>Core Web Vitals</h3><p>${pct(t.cwv.good, t.cwv.tested)} of ${n(t.cwv.tested)} ${name} sites with field data pass all three on mobile, ${compare} the ${pct(data.cwv.good, data.cwv.tested)} average (${esc(monthLabel(data.crux_date))} Chrome UX Report). Themes and third-party scripts affect this as much as the platform.</p></div>`,
    );
  }
  if (t.versions.length >= 2) {
    notes.push(
      `<div><h3>Versions</h3><ul class="seo-mini">${t.versions.map((v) => `<li><span>${esc(v.version)}</span><span class="num">${n(v.sites)}</span></li>`).join("")}</ul><p class="seo-note">Only sites that expose a version.</p></div>`,
    );
  }
  if (t.tlds.length >= 2) {
    notes.push(
      `<div><h3>Top-level domains</h3><ul class="seo-mini">${t.tlds.map((d) => `<li><span>.${esc(d.tld)}</span><span class="num">${pct(d.sites, t.sites)}</span></li>`).join("")}</ul></div>`,
    );
  }
  if (notes.length > 0) {
    sections += block("notes", `More about ${name}`, `        <div class="seo-notes">\n          ${notes.join("\n          ")}\n        </div>`);
  }

  const biggest = t.top_sites.slice(0, 5).map((s) => esc(s.domain));
  const qa = faq([
    {
      q: `How many websites use ${t.name}?`,
      a: `${n(t.sites)} websites ran ${name} in HTTP Archive's ${esc(month)} crawl, ${pct(t.sites, total)} of the ${n(total)} sites it covered.${change}`,
    },
    ...(biggest.length > 0
      ? [{ q: `What are the biggest websites using ${t.name}?`, a: `By Chrome UX Report popularity, the highest-ranked sites running ${name} include ${biggest.join(", ")}.` }]
      : []),
    {
      q: "How is this counted?",
      a: `HTTP Archive loads the home page of every site in the Chrome UX Report, on mobile and desktop, and detects technologies with its open-source Wappalyzer rules. A site counts if ${name} was found on either. Tools that only load on checkout, login or app pages can be missed.`,
    },
  ]);
  sections += block("faq", "Questions", qa.html);

  const hero = `        <div class="seo-title">${techIcon(t, "l")}<div>
          <p class="label">${esc(cats.map((c) => c.name).join(" / ") || "Technology")}</p>
          <h1>${esc(heading)}</h1>
        </div></div>
        <p class="lede">${n(t.sites)} of the ${n(total)} websites in HTTP Archive's ${esc(month)} crawl run ${name}.${change}</p>${
          t.note ? `\n        <p class="seo-flag">${esc(t.note)}</p>` : ""
        }${stats([
          { label: "Sites", value: n(t.sites) },
          { label: "Share of crawl", value: pct(t.sites, total) },
          { label: "Top 10k sites", value: all10k > 0 ? `${n(top10k)} <small>${pct(top10k, all10k)}</small>` : "0" },
          { label: "Top 1M sites", value: all1m > 0 ? `${n(top1m)} <small>${pct(top1m, all1m)}</small>` : "0" },
        ])}`;

  const crumbs: Crumb[] = [{ name: "Home", path: "/" }, { name: "Companies using", path: HUB_PATH }];
  if (main) crumbs.push({ name: main.name, path: categoryPath(main.slug) });
  crumbs.push({ name: t.name });

  const titleStart = override?.heading ?? `Companies using ${t.name}`;
  return {
    indexable,
    html: renderShell({
      path,
      title: `${titleStart}: ${n(t.sites)} websites (${month}) | WhichSitesUse`,
      description: `${n(t.sites)} websites ran ${t.name} in HTTP Archive's ${month} crawl. See the top sites using it${co.length >= 3 ? ", what they run alongside it" : ""} and pull the full list.`,
      indexable,
      crumbs,
      ogImage: ogImage(path),
      dateModified: data.built_at.slice(0, 10),
      structuredData: [
        itemList(`Top sites using ${t.name}`, t.top_sites.map((s) => ({ name: s.domain }))),
        dataset({
          path,
          name: `Websites using ${t.name}, ${month}`,
          description: `Number of websites running ${t.name} in HTTP Archive's ${month} crawl of ${n(total)} sites, split by Chrome UX Report popularity bucket, with the highest-ranked sites${co.length >= 3 ? ", technologies used alongside it" : ""} and top-level domains.`,
          month: data.crawl_date.slice(0, 7),
          dateModified: data.built_at.slice(0, 10),
          measured: ["Websites", "Share of crawled websites", "Websites by popularity bucket"],
        }),
        qa.ld,
      ],
      hero,
      sections,
    }),
  };
}

// ---------- category page ----------

export function renderCategoryPage(plan: PagePlan, slug: string): RenderedPage | null {
  const c = plan.category.get(slug);
  if (!c) return null;
  const { data } = plan;
  const month = monthLabel(data.crawl_date);
  const total = data.total_sites;
  const all10k = within(data.by_rank, 10_000);
  const techs = c.technologies.map((s) => plan.tech.get(s)!);
  const leader = techs[0]!;
  const path = categoryPath(slug);
  const indexable = plan.indexedCategory.has(slug);
  const lower = esc(lowerName(c.name));
  const base = c.sites_estimate > 0 ? c.sites_estimate : leader.sites;

  const rows = techs
    .map((t, i) => {
      const share = pctNum(t.sites, base);
      return `          <li><a class="seo-rank-row" href="${techPath(t.slug)}"><span class="num muted">${i + 1}</span>${techIcon(t)}<strong>${esc(t.name)}</strong>${bar(pctNum(t.sites, leader.sites))}<span class="num">${n(t.sites)}</span><span class="num muted">${pctText(share)}</span><span class="num muted">${all10k > 0 ? pct(within(t.by_rank, 10_000), all10k) : ""}</span></a></li>`;
    })
    .join("\n");

  const sections =
    block(
      "ranking",
      `${n(techs.length)} ${lower} technologies, by sites`,
      `        <div class="seo-rank-head label"><span>#</span><span></span><span>Technology</span><span></span><span class="num">Sites</span><span class="num">Of category</span><span class="num">Top 10k</span></div>
        <ol class="seo-rank">
${rows}
        </ol>
        <p class="seo-note">"Of category" is the share of sites running any ${lower} technology. A site can run several, so the shares add up to more than 100%.</p>`,
    ) +
    `
    <section class="seo-block" id="list">
      <div class="wrap">${listCta(c.sites_estimate, `category=${encodeURIComponent(c.name)}`, `${lowerName(c.name)} sites`)}
      </div>
    </section>`;

  const second = techs[1];
  const hero = `        <h1>Most popular ${lower} technologies</h1>
        <p class="lede">About ${n(c.sites_estimate)} websites in HTTP Archive's ${esc(month)} crawl run at least one. ${esc(leader.name)} leads with ${n(leader.sites)}${second ? `, then ${esc(second.name)} with ${n(second.sites)}` : ""}.</p>${stats([
          { label: "Sites in category", value: `~${n(c.sites_estimate)}` },
          { label: "Share of crawl", value: pct(c.sites_estimate, total) },
          { label: "Technologies", value: n(techs.length) },
          { label: "Leader", value: esc(leader.name) },
        ])}`;

  return {
    indexable,
    html: renderShell({
      path,
      title: `${c.name} market share, ${month}: ${techs.length} technologies ranked | WhichSitesUse`,
      description: `The most popular ${lowerName(c.name)} technologies by number of websites in HTTP Archive's ${month} crawl. ${leader.name} leads with ${n(leader.sites)} sites.`,
      indexable,
      crumbs: [{ name: "Home", path: "/" }, { name: "Companies using", path: HUB_PATH }, { name: "Categories", path: "/categories/" }, { name: c.name }],
      ogImage: ogImage(path),
      dateModified: data.built_at.slice(0, 10),
      pageType: "CollectionPage",
      structuredData: [
        itemList(`Most popular ${lowerName(c.name)} technologies`, techs.map((t) => ({ name: t.name, path: techPath(t.slug) }))),
        dataset({
          path,
          name: `${c.name} market share, ${month}`,
          description: `Number of websites running each ${lowerName(c.name)} technology in HTTP Archive's ${month} crawl of ${n(total)} sites, with each one's share of the category and of the top 10k sites.`,
          month: data.crawl_date.slice(0, 7),
          dateModified: data.built_at.slice(0, 10),
          measured: ["Websites", "Share of category", "Share of top 10k sites"],
        }),
      ],
      hero,
      sections,
    }),
  };
}

// ---------- category index ----------

const categoryCard = (plan: PagePlan, c: SeoCategory) => {
  const top = c.technologies.slice(0, 3).map((s) => plan.tech.get(s)!);
  return `<a class="seo-cat" href="${categoryPath(c.slug)}"><span class="seo-cat-icons">${top.map((t) => techIcon(t, "s")).join("")}</span><strong>${esc(c.name)}</strong><span>${n(c.technologies.length)} technologies · ~${compact(c.sites_estimate)} sites</span><span class="seo-cat-top">${top.map((t) => esc(t.name)).join(", ")}</span></a>`;
};

export function renderCategoryIndex(plan: PagePlan): RenderedPage {
  const { data } = plan;
  const month = monthLabel(data.crawl_date);
  const cats = [...plan.category.values()];
  const sections = block(
    "all",
    `All ${n(cats.length)} categories`,
    `        <ul class="seo-grid seo-cats">
${cats.map((c) => `          <li>${categoryCard(plan, c)}</li>`).join("\n")}
        </ul>`,
  );
  const hero = `        <h1>Technology categories</h1>
        <p class="lede">${n(cats.length)} categories and ${n(plan.tech.size)} technologies from HTTP Archive's ${esc(month)} crawl of ${n(data.total_sites)} websites, ranked by how many sites run them.</p>`;
  return {
    indexable: true,
    html: renderShell({
      path: "/categories/",
      title: `Technology categories and market share (${month}) | WhichSitesUse`,
      description: `${cats.length} technology categories, each ranked by how many of the ${n(data.total_sites)} websites in HTTP Archive's ${month} crawl run its technologies.`,
      indexable: true,
      crumbs: [{ name: "Home", path: "/" }, { name: "Companies using", path: HUB_PATH }, { name: "Categories" }],
      ogImage: `${API}/og/categories.png`,
      dateModified: data.built_at.slice(0, 10),
      pageType: "CollectionPage",
      structuredData: [itemList("Technology categories", cats.map((c) => ({ name: c.name, path: categoryPath(c.slug) })))],
      hero,
      sections,
    }),
  };
}

// ---------- hub: every technology ----------

/** The search script on the hub: filters the embedded list as you type. Kept tiny and dependency-free. */
const HUB_SEARCH_JS = `
(function () {
  var data = JSON.parse(document.getElementById("tech-index").textContent);
  var input = document.getElementById("tech-search");
  var out = document.getElementById("tech-results");
  var key = function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ""); };
  data.forEach(function (t) { t.k = key(t.n); });
  input.addEventListener("input", function () {
    var q = key(input.value);
    out.innerHTML = "";
    if (!q) { out.hidden = true; return; }
    var hits = data.filter(function (t) { return t.k.indexOf(q) !== -1; })
      .sort(function (a, b) { return (b.k.indexOf(q) === 0) - (a.k.indexOf(q) === 0) || b.c - a.c; })
      .slice(0, 12);
    hits.forEach(function (t) {
      var a = document.createElement("a");
      a.href = "/companies-using/" + t.s + "/";
      a.className = "seo-hit";
      var name = document.createElement("strong");
      name.textContent = t.n;
      var meta = document.createElement("span");
      meta.textContent = t.c.toLocaleString("en-US") + " sites" + (t.g ? " · " + t.g : "");
      a.appendChild(name); a.appendChild(meta);
      out.appendChild(a);
    });
    if (!hits.length) out.innerHTML = '<p class="seo-note">No technology with 100 or more sites matches that.</p>';
    out.hidden = false;
  });
})();`;

export function renderHub(plan: PagePlan): RenderedPage {
  const { data } = plan;
  const month = monthLabel(data.crawl_date);
  const all = [...plan.tech.values()];
  const top = all.slice(0, 40);
  const cats = [...plan.category.values()].slice(0, 24);
  const index = all.map((t) => ({ n: t.name, s: t.slug, c: t.sites, g: plan.categoriesFor(t)[0]?.name ?? "" }));
  const hubFaq = faq([
    {
      q: "Is a result a company or a website?",
      a: "A website. Most companies run one main site, so a list of domains gets you most of the way to a list of companies, but a company that runs the same tool on three domains shows up three times, and there are no contacts or firmographics.",
    },
    {
      q: "Why isn't a technology listed?",
      a: `Pages start at ${n(plan.rules.minPageSites)} sites. The API still counts and lists technologies below that: <code>find_technologies</code> finds them for free.`,
    },
  ]);

  const sections =
    block(
      "top",
      "Most used technologies",
      `        <ul class="seo-grid seo-chips">
${top.map((t) => `          <li>${techCard(plan, t, `${compact(t.sites)} sites · ${esc(plan.categoriesFor(t)[0]?.name ?? "")}`)}</li>`).join("\n")}
        </ul>`,
    ) +
    block(
      "categories",
      "Browse by category",
      `        <ul class="seo-grid seo-cats">
${cats.map((c) => `          <li>${categoryCard(plan, c)}</li>`).join("\n")}
        </ul>`,
      `<a class="btn btn-small btn-secondary" href="/categories/">All ${n(plan.category.size)} categories</a>`,
    ) +
    block(
      "how",
      "From a technology to a list of companies",
      `        <ol class="seo-steps">
          <li><strong>Pick a technology</strong><span>Each page shows how many sites run it and the biggest ones, with the full list a click away.</span></li>
          <li><strong>Count for free</strong><span><code>count_sites</code> sizes any filter, by popularity, TLD, other technologies or Core Web Vitals, and tells you what the list would cost.</span></li>
          <li><strong>Pull the domains</strong><span><code>search_sites</code> returns the sites at 1 credit each, from Claude, ChatGPT or the REST API. Take them to your enrichment tool for contacts.</span></li>
        </ol>`,
      `<a class="btn btn-small btn-secondary" href="/docs/">Docs</a>`,
    ) +
    block("faq", "Questions", hubFaq.html);

  const hero = `        <h1>Find companies by technology</h1>
        <p class="lede">${n(all.length)} technologies across ${n(plan.category.size)} categories, from HTTP Archive's ${esc(month)} crawl of ${n(data.total_sites)} websites. Pick one to see the sites that run it.</p>
        <div class="seo-search">
          <label class="visually-hidden" for="tech-search">Search technologies</label>
          <input id="tech-search" type="search" placeholder="Search ${n(all.length)} technologies, e.g. Klaviyo" autocomplete="off">
          <div id="tech-results" class="seo-hits" hidden></div>
        </div>
        <script type="application/json" id="tech-index">${jsonLd(index)}</script>
        <script>${HUB_SEARCH_JS}</script>`;

  return {
    indexable: true,
    html: renderShell({
      path: HUB_PATH,
      title: `Find companies by technology: ${n(all.length)} technologies (${month}) | WhichSitesUse`,
      description: `Find the websites that run any of ${n(all.length)} technologies, from HTTP Archive's ${month} crawl of ${n(data.total_sites)} sites. Free counts, lists at 1 credit per site.`,
      indexable: true,
      crumbs: [{ name: "Home", path: "/" }, { name: "Companies using" }],
      ogImage: `${API}/og/companies-using.png`,
      dateModified: data.built_at.slice(0, 10),
      pageType: "CollectionPage",
      structuredData: [itemList("Most used technologies", top.map((t) => ({ name: t.name, path: techPath(t.slug) }))), hubFaq.ld],
      hero,
      sections,
    }),
  };
}

export function renderSitemap(plan: PagePlan): string {
  const lastmod = plan.data.built_at.slice(0, 10);
  const urls = plan
    .sitemapPaths()
    .map((p) => `  <url><loc>${esc(absolute(p))}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
