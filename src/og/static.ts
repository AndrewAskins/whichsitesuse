import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ogPng, type OgCard } from "./card.js";

/**
 * Renders OG images for hand-written pages with the same template as the generated ones.
 * Usage: npm run og:static -- <cards.json>
 * cards.json: [{ "out": "site/og/docs.png", "eyebrow": "Docs", "title": "...", "stat": "...", "statLabel": "...", "footnote": "...", "icon": "site/assets/x.png" }]
 * `icon` is an optional path to a PNG.
 */
type StaticCard = Omit<OgCard, "icon"> & { out: string; icon?: string };

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run og:static -- <cards.json>");
  process.exit(1);
}
const cards = JSON.parse(await readFile(file, "utf8")) as StaticCard[];
for (const c of cards) {
  const png = ogPng({ ...c, icon: c.icon ? await readFile(resolve(c.icon)) : null });
  await mkdir(dirname(resolve(c.out)), { recursive: true });
  await writeFile(resolve(c.out), png);
  console.log(`wrote ${c.out}`);
}
