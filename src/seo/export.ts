import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PagePlan, renderCategoryIndex, renderCategoryPage, renderHub, renderSitemap, renderTechPage, type RenderedPage } from "./pages.js";
import { readSeoDatasetFile } from "./storage.js";

/**
 * Writes the marketing site plus every programmatic page as static files: what
 * whichsitesuse.com would serve once the rewrites are on. Used for PR previews.
 * A static file already in site/ at the same path wins, as it would on Render.
 */
export async function exportSite(plan: PagePlan, siteDir: string, outDir: string): Promise<number> {
  await cp(siteDir, outDir, { recursive: true });
  let written = 0;
  const write = async (path: string, page: RenderedPage | null) => {
    const file = join(outDir, path, "index.html");
    if (!page || existsSync(join(siteDir, path, "index.html"))) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, page.html);
    written++;
  };
  for (const slug of plan.tech.keys()) await write(`/companies-using/${slug}/`, renderTechPage(plan, slug));
  for (const slug of plan.category.keys()) await write(`/categories/${slug}/`, renderCategoryPage(plan, slug));
  await write("/categories/", renderCategoryIndex(plan));
  await write("/companies-using/", renderHub(plan));
  await mkdir(join(outDir, "sitemaps"), { recursive: true });
  await writeFile(join(outDir, "sitemaps", "technologies.xml"), renderSitemap(plan));
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dataset, out = "preview"] = process.argv.slice(2);
  if (!dataset) {
    console.error("Usage: tsx src/seo/export.ts <dataset.json> [outDir]");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const plan = new PagePlan(await readSeoDatasetFile(dataset));
  const n = await exportSite(plan, join(root, "site"), resolve(out));
  console.log(`Wrote ${n} pages to ${out} (${plan.indexedTech.size} indexable technology pages, ${plan.indexedCategory.size} indexable categories).`);
}
