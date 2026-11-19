import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SITE_ORIGIN } from "./config.js";

/**
 * Sharp vector logos for the technologies we feature, served by the marketing site from
 * site/logos/<slug>.svg. Every other technology keeps HTTP Archive's small CDN icon.
 * Sources: Simple Icons and gilbarbara/logos (both CC0), and Klaviyo's own site for its flag.
 * To add one, drop <slug>.svg in site/logos: this list is read from that folder.
 */
const LOGO_DIR = fileURLToPath(new URL("../../site/logos/", import.meta.url));

function readSlugs(): Set<string> {
  try {
    return new Set(readdirSync(LOGO_DIR).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
  } catch {
    return new Set();
  }
}

const LOGO_SLUGS = readSlugs();

/** Absolute, so it works on directory pages whichever host serves them. */
export function logoUrl(slug: string): string | null {
  return LOGO_SLUGS.has(slug) ? `${SITE_ORIGIN}/logos/${slug}.svg` : null;
}
