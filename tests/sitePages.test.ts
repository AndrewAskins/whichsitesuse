import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { loadPartials, pages, syncPage } from "../scripts/sync-site.mjs";

const all: string[] = pages();
const partials: Record<string, string> = loadPartials();

describe("marketing site pages", () => {
  it("share the head, header and footer from scripts/site-partials (run npm run site:sync)", () => {
    const stale = all.filter((p) => {
      const html = readFileSync(p, "utf8");
      return syncPage(html, partials) !== html;
    });
    expect(stale.map((p) => relative(process.cwd(), p))).toEqual([]);
  });

  it.each(all.map((p) => [relative(process.cwd(), p), p]))("%s uses every shared partial once", (_name, path) => {
    const html = readFileSync(path, "utf8");
    for (const name of ["head", "header", "footer"]) {
      expect(html.split(`<!-- @partial ${name} -->`).length - 1).toBe(1);
    }
  });

  it("list every page in the sitemap", () => {
    const sitemap = readFileSync("site/sitemap.xml", "utf8");
    const missing = all
      .map((p) => relative("site", p).replace(/index\.html$/, ""))
      .filter((path) => !sitemap.includes(`<loc>https://whichsitesuse.com/${path}</loc>`));
    expect(missing).toEqual([]);
  });
});
