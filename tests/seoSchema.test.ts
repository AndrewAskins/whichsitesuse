import { describe, expect, it } from "vitest";
import { breadcrumbList, dataset, faqPage, graph, itemList, ldJson, webPage } from "../src/seo/schema.js";

describe("schema helpers", () => {
  it("wraps nodes in one @graph with the organization and website", () => {
    const g = graph([webPage({ path: "/x/", name: "X", description: "d" })]) as { "@context": string; "@graph": Record<string, unknown>[] };
    expect(g["@context"]).toBe("https://schema.org");
    expect(g["@graph"].map((n) => n["@type"])).toEqual(["Organization", "WebSite", "WebPage"]);
    expect(g["@graph"][2]).toMatchObject({ url: "https://whichsitesuse.com/x/", isPartOf: { "@id": "https://whichsitesuse.com/#website" } });
  });

  it("builds breadcrumbs with absolute items and no item on the last crumb", () => {
    const b = breadcrumbList([{ name: "Home", path: "/" }, { name: "Here" }]) as { itemListElement: Record<string, unknown>[] };
    expect(b.itemListElement[0]).toEqual({ "@type": "ListItem", position: 1, name: "Home", item: "https://whichsitesuse.com/" });
    expect(b.itemListElement[1]).not.toHaveProperty("item");
  });

  it("lists items with positions and optional urls", () => {
    const l = itemList("L", [{ name: "a.com" }, { name: "React", path: "/companies-using/react/" }]) as { numberOfItems: number; itemListElement: Record<string, unknown>[] };
    expect(l.numberOfItems).toBe(2);
    expect(l.itemListElement[0]).not.toHaveProperty("url");
    expect(l.itemListElement[1]).toMatchObject({ position: 2, url: "https://whichsitesuse.com/companies-using/react/" });
  });

  it("strips markup from FAQ answers", () => {
    const f = faqPage([{ q: "Q?", a: "Use <code>count_sites</code>." }]) as { mainEntity: { acceptedAnswer: { text: string } }[] };
    expect(f.mainEntity[0]!.acceptedAnswer.text).toBe("Use count_sites.");
  });

  it("describes a dataset with the fields Google requires", () => {
    const d = dataset({ path: "/x/", name: "Websites using X", description: "A description long enough to pass the fifty character minimum.", month: "2026-11", dateModified: "2026-11-20", measured: ["Websites"] });
    expect(d).toMatchObject({ "@type": "Dataset", name: "Websites using X", temporalCoverage: "2026-11" });
    expect(String(d.description).length).toBeGreaterThanOrEqual(50);
  });

  it("can't break out of its script tag", () => {
    expect(ldJson({ a: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });
});
