import { HANDWRITTEN_TECH_SLUGS, SEO_RULES, type SeoRules } from "./config.js";
import type { RankRow, SeoCategory, SeoDataset, SeoTechnology } from "./dataset.js";
import { absolute, esc, renderShell, type Crumb } from "./layout.js";

/**
 * Renders the programmatic pages from the monthly dataset. Copy is fixed template text;
 * every number, list and comparison comes from the data, and a section only appears
 * when the data behind it is big enough to say something.
 */

export interface RenderedPage {
  html: string;
  indexable: boolean;
}

const API = "https://api.whichsitesuse.com";
const fmt = new Intl.NumberFormat("en-US");
const n = (v: number) => fmt.format(v);
const pct = (part: number, whole: number) => {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  return `${p >= 10 ? Math.round(p) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
};
const share = (s: number) => pct(s, 1);

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

/** Which pages exist and which are indexable, decided from the data and SEO_RULES. */
export class PagePlan {
  readonly tech = new Map<string, SeoTechnology>();
  readonly category = new Map<string, SeoCategory>();
  readonly indexedTech = new Set<string>();
  readonly indexedCategory = new Set<string>();

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
      this.category.set(c.slug, { ...c, technologies: techs });
      if (techs.filter((s) => this.indexedTech.has(s)).length >= rules.minCategoryTechs) this.indexedCategory.add(c.slug);
    }
  }

  categoryOf(name: string): SeoCategory | undefined {
    return [...this.category.values()].find((c) => c.name === name);
  }

  /** The technology's categories that have pages, largest first. */
  categoriesFor(t: SeoTechnology): SeoCategory[] {
    return t.categories
      .map((c) => this.categoryOf(c))
      .filter((c): c is SeoCategory => c !== undefined)
      .sort((a, b) => b.sites_estimate - a.sites_estimate);
  }

  /** Paths that go in the sitemap. Hand-written technology pages are listed by the static site instead. */
  sitemapPaths(): string[] {
    const handwritten = new Set<string>(HANDWRITTEN_TECH_SLUGS);
    return [
      "/categories/",
      ...[...this.indexedCategory].map(categoryPath),
      ...[...this.indexedTech].filter((s) => !handwritten.has(s)).map(techPath),
    ];
  }
}

const techLink = (plan: PagePlan, slug: string) => {
  const t = plan.tech.get(slug);
  return t ? `<a href="${techPath(slug)}">${esc(t.name)}</a>` : esc(slug);
};

const section = (id: string, num: number, label: string, head: string, body: string) => `
    <section class="block" id="${id}">
      <div class="wrap">
        <p class="rule-label">// ${String(num).padStart(2, "0")} &nbsp;${esc(label)}</p>
        <div class="split">
          <div class="section-head">
${head}
          </div>
          <div class="prose">
${body}
          </div>
        </div>
      </div>
    </section>`;

const table = (headers: { label: string; num?: boolean }[], rows: string[][]) => `
            <div class="table-wrap"><table>
              <thead><tr>${headers.map((h) => `<th${h.num ? ' class="num"' : ""}>${esc(h.label)}</th>`).join("")}</tr></thead>
              <tbody>
${rows.map((r) => `                <tr>${r.map((c, i) => `<td${headers[i]?.num ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("\n")}
              </tbody>
            </table></div>`;

const stats = (items: { label: string; value: string }[]) => `
        <dl class="seo-stats">
${items.map((s) => `          <div><dt class="label">${esc(s.label)}</dt><dd>${s.value}</dd></div>`).join("\n")}
        </dl>`;

const faq = (items: { q: string; a: string }[]) => ({
  html: `
            <div class="faq-list">
${items.map((i) => `              <details>\n                <summary><h3>${esc(i.q)}</h3></summary>\n                <p>${i.a}</p>\n              </details>`).join("\n")}
            </div>`,
  ld: {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a.replace(/<[^>]+>/g, "") },
    })),
  },
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

export function renderTechPage(plan: PagePlan, slug: string): RenderedPage | null {
  const t = plan.tech.get(slug);
  if (!t) return null;
  const { data, rules } = plan;
  const month = monthLabel(data.crawl_date);
  const cruxMonth = monthLabel(data.crux_date);
  const labels = rankLabels(data.by_rank);
  const total = data.total_sites;
  const name = esc(t.name);
  const path = techPath(slug);
  const indexable = plan.indexedTech.has(slug);
  const cats = plan.categoriesFor(t);
  const main = cats[0];
  const placeInMain = main ? main.technologies.indexOf(slug) + 1 : 0;

  const top10k = within(t.by_rank, 10_000);
  const all10k = within(data.by_rank, 10_000);
  const top1m = within(t.by_rank, 1_000_000);
  const all1m = within(data.by_rank, 1_000_000);

  let sections = "";
  let num = 0;

  // 01: named sites, the reason most people land here.
  if (t.top_sites.length > 0) {
    const shown = t.top_sites.length;
    const best = labels.get(t.top_sites[0]!.rank_bucket)?.toLowerCase() ?? "";
    sections += section(
      "sites",
      ++num,
      "Sites",
      `            <h2>The highest-ranked sites running ${name}</h2>
            <p class="intro">Chrome UX Report sorts sites into popularity buckets (top 1k, top 5k and so on) instead of exact ranks. These are the ${n(shown)} best-ranked sites we found with ${name}, starting in the ${esc(best)} bucket.</p>`,
      table(
        [{ label: "Site" }, { label: "Popularity" }],
        t.top_sites.map((s) => [esc(s.domain), esc(labels.get(s.rank_bucket) ?? "")]),
      ) +
        `
            <div class="callout seo-cta">
              <p><strong>Want all ${n(t.sites)}?</strong> Counting is free, and the list costs 1 credit per site, so the full list is ${n(t.sites)} credits. Filter by popularity, top-level domain, other technologies or Core Web Vitals to cut it down first.</p>
              <pre class="config"><code>GET ${API}/v1/counts?technologies=${esc(slug)}
GET ${API}/v1/sites?technologies=${esc(slug)}&amp;max_rank=100000</code></pre>
              <p>The same filters work from Claude or ChatGPT through the MCP server. <a href="/docs/">Read the docs</a> or <a href="${API}/signup">get 250 free credits</a>.</p>
            </div>`,
    );
  }

  // 02: adoption by popularity bucket.
  const rankRows = data.by_rank
    .map((b) => {
      const mine = t.by_rank.find((r) => r.rank_bucket === b.rank_bucket)?.sites ?? 0;
      return [esc(labels.get(b.rank_bucket) ?? ""), n(mine), pct(mine, b.sites)];
    });
  let popularity = "";
  if (all10k > 0 && top10k > 0) {
    const ratio = top10k / all10k / (t.sites / total);
    popularity =
      ratio >= 1.25
        ? `${name} is more common among popular sites: it runs on ${pct(top10k, all10k)} of the top 10k, against ${pct(t.sites, total)} of the whole crawl.`
        : ratio <= 0.8
          ? `${name} is less common among popular sites: it runs on ${pct(top10k, all10k)} of the top 10k, against ${pct(t.sites, total)} of the whole crawl.`
          : `${name} is about as common among the top 10k sites (${pct(top10k, all10k)}) as across the whole crawl (${pct(t.sites, total)}).`;
  } else if (top10k === 0 && all10k > 0) {
    popularity = `None of the top 10k sites run ${name}; its biggest sites sit further down the popularity ranks.`;
  }
  sections += section(
    "popularity",
    ++num,
    "Popularity",
    `            <h2>How common ${name} is at each popularity level</h2>
            <p class="intro">${popularity}</p>`,
    table([{ label: "Popularity" }, { label: `Sites with ${t.name}`, num: true }, { label: "Share of bucket", num: true }], rankRows),
  );

  // 03: technologies over-represented on these sites.
  const co = (t.co_used ?? []).filter((c) => plan.tech.has(c.slug));
  if (co.length >= 3) {
    sections += section(
      "stack",
      ++num,
      "Stack",
      `            <h2>What ${name} sites also run</h2>
            <p class="intro">Technologies that turn up on ${name} sites far more often than on the average site. Shares are estimated from 1 in ${n(data.co_usage_sample_every)} crawled sites.</p>`,
      table(
        [{ label: "Technology" }, { label: `Share of ${t.name} sites`, num: true }, { label: "Share of all sites", num: true }],
        co.map((c) => [techLink(plan, c.slug), share(c.share), share(c.base_share)]),
      ),
    );
  }

  // 04: Core Web Vitals.
  if (t.cwv.tested >= rules.cwvMinTested && data.cwv.tested > 0) {
    const mine = t.cwv.good / t.cwv.tested;
    const base = data.cwv.good / data.cwv.tested;
    const compare =
      mine > base * 1.1 ? "better than" : mine < base * 0.9 ? "worse than" : "close to";
    sections += section(
      "performance",
      ++num,
      "Performance",
      `            <h2>Core Web Vitals on ${name} sites</h2>
            <p class="intro">Mobile field data from the ${esc(cruxMonth)} Chrome UX Report, at the 75th percentile.</p>`,
      `            <p>${pct(t.cwv.good, t.cwv.tested)} of the ${n(t.cwv.tested)} ${name} sites with field data pass all three Core Web Vitals on mobile (LCP, INP and CLS all rated good). That's ${compare} the ${pct(data.cwv.good, data.cwv.tested)} pass rate across every crawled site with field data. Read it as a rough signal, since themes and third-party scripts move these scores as much as the platform itself.</p>`,
    );
  }

  // 05: versions and top-level domains.
  const parts: string[] = [];
  if (t.versions.length >= 2) {
    const withVersion = t.versions.reduce((s, v) => s + v.sites, 0);
    parts.push(
      `            <h3>Versions</h3>
            <p>${n(withVersion)} sites expose a version number. Most installs hide it, so treat this as a sample.</p>` +
        table([{ label: "Version" }, { label: "Sites", num: true }], t.versions.map((v) => [esc(v.version), n(v.sites)])),
    );
  }
  if (t.tlds.length >= 2) {
    parts.push(
      `            <h3>Top-level domains</h3>` +
        table(
          [{ label: "Domain" }, { label: "Sites", num: true }, { label: `Share of ${t.name} sites`, num: true }],
          t.tlds.map((d) => [`.${esc(d.tld)}`, n(d.sites), pct(d.sites, t.sites)]),
        ),
    );
  }
  if (parts.length > 0) {
    sections += section(
      "detail",
      ++num,
      "Detail",
      `            <h2>Versions and domains</h2>
            <p class="intro">Country-code domains hint at where a technology is popular, though plenty of sites everywhere use .com.</p>`,
      parts.join("\n"),
    );
  }

  // 06: the rest of its category.
  if (main) {
    const peers = main.technologies.filter((s) => s !== slug).slice(0, 8);
    if (peers.length > 0) {
      sections += section(
        "alternatives",
        ++num,
        "Alternatives",
        `            <h2>Other ${esc(main.name.toLowerCase())} technologies</h2>
            <p class="intro">${name} ranks ${n(placeInMain)} of ${n(main.technologies.length)} in <a href="${categoryPath(main.slug)}">${esc(main.name)}</a> by number of sites.</p>`,
        table(
          [{ label: "Technology" }, { label: "Sites", num: true }, { label: "Share of crawl", num: true }],
          peers.map((s) => {
            const p = plan.tech.get(s)!;
            return [techLink(plan, s), n(p.sites), pct(p.sites, total)];
          }),
        ),
      );
    }
  }

  // 07: questions, answered from the same numbers.
  const biggest = t.top_sites.slice(0, 5).map((s) => esc(s.domain));
  const qa = faq([
    {
      q: `How many websites use ${t.name}?`,
      a: `${n(t.sites)} websites ran ${name} in HTTP Archive's ${esc(month)} crawl, ${pct(t.sites, total)} of the ${n(total)} sites it covered.${changeSentence(t, previousMonthOf(data.crawl_date))}`,
    },
    ...(biggest.length > 0
      ? [{ q: `What are the biggest websites using ${t.name}?`, a: `By Chrome UX Report popularity, the highest-ranked sites we found running ${name} include ${biggest.join(", ")}.` }]
      : []),
    {
      q: "How is this counted?",
      a: `HTTP Archive loads the home page of every site in the Chrome UX Report, on mobile and desktop, and detects technologies with its open-source Wappalyzer rules. A site counts if ${name} was detected on either device. Only home pages are checked, so a tool that runs only on a checkout, login or app page can be missed.`,
    },
  ]);
  sections += section("faq", ++num, "Questions", `            <h2>Questions</h2>`, qa.html);

  const hero = `        <p class="label">${esc(cats.map((c) => c.name).join(" / ") || "Technology")}</p>
        <h1>Which sites use ${name}?</h1>
        <p class="lede">${n(t.sites)} of the ${n(total)} websites in HTTP Archive's ${esc(month)} crawl run ${name}.${changeSentence(t, previousMonthOf(data.crawl_date))}</p>${
          t.note ? `\n        <p class="seo-note">${esc(t.note)}</p>` : ""
        }${stats([
          { label: "Sites", value: n(t.sites) },
          { label: "Share of crawl", value: pct(t.sites, total) },
          { label: "Top 10k sites", value: all10k > 0 ? `${n(top10k)} <small>(${pct(top10k, all10k)})</small>` : "0" },
          { label: "Top 1M sites", value: all1m > 0 ? `${n(top1m)} <small>(${pct(top1m, all1m)})</small>` : "0" },
        ])}
        <p class="seo-source">Source: HTTP Archive crawl, ${esc(month)}. Updated every month.</p>`;

  const crumbs: Crumb[] = [{ name: "Home", path: "/" }, { name: "Companies using", path: "/companies-using/" }];
  if (main) crumbs.push({ name: main.name, path: categoryPath(main.slug) });
  crumbs.push({ name: t.name });

  return {
    indexable,
    html: renderShell({
      path,
      title: `Websites using ${t.name}: ${n(t.sites)} sites (${month}) | WhichSitesUse`,
      description: `${n(t.sites)} websites ran ${t.name} in the ${month} HTTP Archive crawl. See the highest-ranked ones, how adoption changes with popularity, and what they run alongside it.`,
      indexable,
      crumbs,
      structuredData: [
        qa.ld,
        {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: `Websites using ${t.name}`,
          url: absolute(path),
          dateModified: data.built_at.slice(0, 10),
          isBasedOn: "https://httparchive.org",
        },
      ],
      hero,
      sections,
    }),
  };
}

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
  const cname = esc(c.name);
  const lower = esc(c.name.toLowerCase());

  const rows = techs.map((t, i) => [
    String(i + 1),
    techLink(plan, t.slug),
    n(t.sites),
    pct(t.sites, total),
    c.sites_estimate > 0 ? pct(t.sites, c.sites_estimate) : "",
    all10k > 0 ? pct(within(t.by_rank, 10_000), all10k) : "",
  ]);

  const second = techs[1];
  const lead =
    second && leader.sites >= second.sites * 2
      ? ` ${esc(leader.name)} is more than twice the size of ${esc(second.name)}, the next one down.`
      : second
        ? ` ${esc(second.name)} is next with ${n(second.sites)}.`
        : "";

  const sections = section(
    "ranking",
    1,
    "Ranking",
    `            <h2>${cname} technologies by number of sites</h2>
            <p class="intro">A site can run more than one ${lower} technology, so the shares of category sites add up to more than 100%.</p>`,
    table(
      [
        { label: "#" },
        { label: "Technology" },
        { label: "Sites", num: true },
        { label: "Share of crawl", num: true },
        { label: "Share of category", num: true },
        { label: "Top 10k share", num: true },
      ],
      rows,
    ),
  ) +
    section(
      "lists",
      2,
      "Lists",
      `            <h2>Pull the sites behind any row</h2>`,
      `            <p>Every number here is a free count from the API. Lists cost 1 credit per site, and you can filter by popularity, top-level domain, other technologies or Core Web Vitals.</p>
            <pre class="config"><code>GET ${API}/v1/counts?category=${encodeURIComponent(c.name)}</code></pre>
            <p><a href="/docs/">Read the docs</a> or <a href="${API}/signup">get 250 free credits</a>.</p>`,
    );

  const hero = `        <p class="label">Category</p>
        <h1>Most popular ${lower} technologies</h1>
        <p class="lede">About ${n(c.sites_estimate)} of the ${n(total)} websites in HTTP Archive's ${esc(month)} crawl run at least one ${lower} technology. ${esc(leader.name)} leads with ${n(leader.sites)} sites.${lead}</p>${stats([
          { label: "Sites in category", value: `~${n(c.sites_estimate)}` },
          { label: "Share of crawl", value: pct(c.sites_estimate, total) },
          { label: "Technologies ranked", value: n(techs.length) },
          { label: "Leader", value: techLink(plan, leader.slug) },
        ])}
        <p class="seo-source">Source: HTTP Archive crawl, ${esc(month)}. Category site counts are estimates within about 2%.</p>`;

  return {
    indexable,
    html: renderShell({
      path,
      title: `${c.name} market share, ${month}: ${techs.length} technologies ranked | WhichSitesUse`,
      description: `The most popular ${c.name.toLowerCase()} technologies by number of websites in the ${month} HTTP Archive crawl. ${leader.name} leads with ${n(leader.sites)} sites.`,
      indexable,
      crumbs: [{ name: "Home", path: "/" }, { name: "Categories", path: "/categories/" }, { name: c.name }],
      structuredData: [
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: `Most popular ${c.name.toLowerCase()} technologies`,
          itemListElement: techs.slice(0, 50).map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, url: absolute(techPath(t.slug)) })),
        },
      ],
      hero,
      sections,
    }),
  };
}

export function renderCategoryIndex(plan: PagePlan): RenderedPage {
  const { data } = plan;
  const month = monthLabel(data.crawl_date);
  const cats = [...plan.category.values()];
  const cards = cats
    .map((c) => {
      const top = c.technologies.slice(0, 3).map((s) => esc(plan.tech.get(s)!.name)).join(", ");
      return `          <a href="${categoryPath(c.slug)}"><h3>${esc(c.name)}</h3><p>~${n(c.sites_estimate)} sites. ${top}</p></a>`;
    })
    .join("\n");
  const sections = `
    <section class="block" id="all">
      <div class="wrap">
        <p class="rule-label">// 01 &nbsp;All categories</p>
        <div class="card-grid">
${cards}
        </div>
      </div>
    </section>`;
  const hero = `        <p class="label">Categories</p>
        <h1>Technology categories</h1>
        <p class="lede">${n(cats.length)} categories and ${n(plan.tech.size)} technologies from HTTP Archive's ${esc(month)} crawl of ${n(data.total_sites)} websites, ranked by how many sites run them.</p>`;
  return {
    indexable: true,
    html: renderShell({
      path: "/categories/",
      title: `Technology categories and market share (${month}) | WhichSitesUse`,
      description: `Browse ${cats.length} technology categories, from CMS and ecommerce to analytics, ranked by how many of ${n(data.total_sites)} crawled websites use each technology.`,
      indexable: true,
      crumbs: [{ name: "Home", path: "/" }, { name: "Categories" }],
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
