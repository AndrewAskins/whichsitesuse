import { log } from "../log.js";

/**
 * Icons and one-line descriptions for technologies, from HTTP Archive's public
 * Tech Report API (the same Wappalyzer rules our detections come from). Read once
 * a month by the pipeline; the pages hotlink the icons from HTTP Archive's CDN.
 */
export const TECH_REPORT_API = "https://cdn.httparchive.org/v1/technologies";
export const TECH_ICON_BASE = "https://cdn.httparchive.org/v1/static/icons/";

export interface CatalogEntry {
  icon: string | null;
  description: string | null;
}

interface TechReportRow {
  technology?: string;
  icon?: string;
  description?: string;
}

/** Icon file names in the API end in .svg; the CDN serves them as .png. */
export const iconFile = (icon: string) => icon.replace(/\.(svg|png|ico|gif|jpe?g)$/i, "") + ".png";

export function parseCatalog(rows: TechReportRow[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const r of rows) {
    if (!r.technology) continue;
    map.set(r.technology, {
      icon: r.icon ? iconFile(r.icon) : null,
      description: r.description?.trim() || null,
    });
  }
  return map;
}

/** Returns an empty map on any failure: icons and descriptions are optional. */
export async function fetchTechCatalog(fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<Map<string, CatalogEntry>> {
  try {
    const res = await fetchImpl(`${TECH_REPORT_API}?technology=ALL`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as TechReportRow[];
    const map = parseCatalog(Array.isArray(rows) ? rows : []);
    log.info({ technologies: map.size }, "technology catalog loaded");
    return map;
  } catch (err) {
    log.warn({ err }, "technology catalog unavailable; pages show letter tiles instead of icons");
    return new Map();
  }
}
