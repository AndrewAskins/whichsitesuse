/**
 * Per-technology copy that the template can't derive: the keyword each page targets
 * (from the search demand research in Notion) and a short note on how detection works
 * where it matters. Numbers never go here; they come from the dataset.
 */
export interface TechPageOverride {
  /** H1 and the start of the <title>, e.g. "Shopify stores list". */
  heading: string;
  /** One or two sentences on what the count includes and misses. */
  detection?: string;
}

export const TECH_PAGE_OVERRIDES: Record<string, TechPageOverride> = {
  shopify: {
    heading: "Shopify stores list",
    detection:
      "A store counts when the crawler sees one of Shopify's own signals, such as its cookies, a powered-by header or requests to a myshopify.com address, or one of the Shopify apps that imply it. Plus and standard stores can't be told apart, and a custom headless front end that loads none of these signals can be missed.",
  },
  hubspot: {
    heading: "Companies using HubSpot",
    detection:
      "The HubSpot entry already takes in sites matched by CMS Hub and the WordPress plugin. HubSpot's analytics, chat and cookie banner entries are separate, so search for any of them for the widest list. Code that only sits on forms or landing pages deeper in a site can be missed.",
  },
  salesforce: {
    heading: "Companies using Salesforce",
    detection:
      "Sales Cloud runs behind a login, so a company that uses Salesforce only as its CRM looks like any other site. What the crawl sees is what the website loads: Commerce Cloud, Service Cloud chat, Pardot and Marketing Cloud tags, each its own entry.",
  },
  stripe: {
    heading: "Who uses Stripe",
    detection:
      "A business that only uses Stripe Checkout or Payment Links sends customers to a page on Stripe's own domain, so it isn't counted unless Stripe.js also loads on its own pages. The same goes for checkouts on a separate app subdomain.",
  },
};
