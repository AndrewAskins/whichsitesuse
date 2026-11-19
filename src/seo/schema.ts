import { SITE_ORIGIN } from "./config.js";

/**
 * JSON-LD for every page, in one place. Each page emits one <script type="application/ld+json">
 * holding a @graph, so the nodes can reference each other by @id. The hand-written pages use
 * the same builders, so the whole site describes itself one way.
 */
export type Node = Record<string, unknown>;

export const absolute = (path: string) => (path.startsWith("http") ? path : `${SITE_ORIGIN}${path}`);

export const ORGANIZATION: Node = {
  "@type": "Organization",
  "@id": `${SITE_ORIGIN}/#organization`,
  name: "WhichSitesUse",
  url: `${SITE_ORIGIN}/`,
  logo: `${SITE_ORIGIN}/assets/apple-touch-icon-180.png`,
  parentOrganization: { "@type": "Organization", name: "Disco Shrimp Company, LLC" },
};

export const WEBSITE: Node = {
  "@type": "WebSite",
  "@id": `${SITE_ORIGIN}/#website`,
  name: "WhichSitesUse",
  url: `${SITE_ORIGIN}/`,
  publisher: { "@id": ORGANIZATION["@id"] },
};

export interface Crumb {
  name: string;
  path?: string;
}

export function breadcrumbList(crumbs: Crumb[]): Node {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: absolute(c.path) } : {}),
    })),
  };
}

export function webPage(p: { path: string; name: string; description: string; dateModified?: string; image?: string; type?: "WebPage" | "CollectionPage" }): Node {
  return {
    "@type": p.type ?? "WebPage",
    "@id": `${absolute(p.path)}#webpage`,
    url: absolute(p.path),
    name: p.name,
    description: p.description,
    isPartOf: { "@id": WEBSITE["@id"] },
    ...(p.dateModified ? { dateModified: p.dateModified } : {}),
    ...(p.image ? { primaryImageOfPage: { "@type": "ImageObject", url: p.image, width: 1200, height: 630 } } : {}),
  };
}

/** A list of things; items with a path link to our page, items without one are just named. */
export function itemList(name: string, items: { name: string; path?: string }[]): Node {
  return {
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      ...(it.path ? { url: absolute(it.path) } : {}),
    })),
  };
}

export function faqPage(items: { q: string; a: string }[]): Node {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a.replace(/<[^>]+>/g, "") },
    })),
  };
}

/** The counts on a page as a Dataset: derived from HTTP Archive's public crawl, one month. */
export function dataset(d: { path: string; name: string; description: string; month: string; dateModified: string; measured: string[] }): Node {
  return {
    "@type": "Dataset",
    "@id": `${absolute(d.path)}#dataset`,
    name: d.name,
    description: d.description,
    url: absolute(d.path),
    temporalCoverage: d.month,
    dateModified: d.dateModified,
    variableMeasured: d.measured,
    creator: { "@id": ORGANIZATION["@id"] },
    isBasedOn: { "@type": "Dataset", name: "HTTP Archive crawl", url: "https://httparchive.org/" },
    isAccessibleForFree: true,
  };
}

/** One JSON-LD document for a page. Organization and WebSite ride along so @id references resolve. */
export function graph(nodes: Node[]): Node {
  return { "@context": "https://schema.org", "@graph": [ORGANIZATION, WEBSITE, ...nodes] };
}

/** JSON for a <script type="application/ld+json"> block, safe against "</script>". */
export const ldJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
