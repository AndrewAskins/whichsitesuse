import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { pages } from "../scripts/sync-site.mjs";
import { PAGES, imageName, pageFile, schemaFor, stalePages, visibleFaq } from "../src/site/meta.js";

/** Pages the SEO generator owns, with their own metadata. */
const generated = (path: string) => path.startsWith("site/companies-using/");

describe("hand-written page metadata", () => {
  it("is in sync with src/site/meta.ts (run npm run site:meta)", () => {
    expect(stalePages()).toEqual([]);
  });

  it("covers every hand-written page", () => {
    const listed = new Set(PAGES.map((p) => relative(process.cwd(), pageFile(p))));
    const all = (pages() as string[]).map((p) => relative(process.cwd(), p)).filter((p) => !generated(p));
    expect(all.filter((p) => !listed.has(p))).toEqual([]);
  });

  it("gives every page a unique title and description and its own share image", () => {
    expect(new Set(PAGES.map((p) => p.title)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.description)).size).toBe(PAGES.length);
    for (const p of PAGES) {
      expect(existsSync(`site/og/${imageName(p)}`), p.path).toBe(true);
      expect(p.description.length, p.path).toBeLessThanOrEqual(170);
    }
    expect(existsSync("site/og/default.png")).toBe(true);
  });

  it("adds FAQPage schema exactly where a page shows an FAQ", () => {
    for (const p of PAGES) {
      const html = readFileSync(pageFile(p), "utf8");
      const types = (schemaFor(p, html)["@graph"] as { "@type": string }[]).map((n) => n["@type"]);
      expect(types.includes("FAQPage"), p.path).toBe(visibleFaq(html).length > 0);
    }
  });

  it("reads questions and answers from the visible FAQ markup", () => {
    const html = `<div class="faq-list">
      <details>
        <summary><h3>Is it free?</h3></summary>
        <p>No, but <a href="/">new accounts</a> get 250 credits &amp; more.</p>
      </details>
    </div>`;
    expect(visibleFaq(html)).toEqual([{ q: "Is it free?", a: "No, but new accounts get 250 credits & more." }]);
  });
});
