import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

/**
 * The one Open Graph card template for every page (1200x630): the WhichSitesUse logo,
 * a mono eyebrow, the page's subject with its logo, and one number. Cool gray, Geist,
 * the moon-yellow accent. Generated pages render it on request; hand-written pages
 * render theirs once with `npm run og:static`.
 */
export interface OgCard {
  eyebrow: string;
  title: string;
  /** The big number, e.g. "3,631,229". */
  stat?: string;
  /** What the number counts, e.g. "websites run React". */
  statLabel?: string;
  footnote?: string;
  /** PNG bytes of the subject's logo, drawn on a tile left of the title. */
  icon?: Buffer | null;
}

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FONT_FILES = ["Geist-Regular.ttf", "Geist-SemiBold.ttf", "GeistMono-Medium.ttf"].map((f) => root(`assets/og/fonts/${f}`));

let logo: string | null = null;
/** The light-mode wordmark, as a nested <svg>, without its metadata. */
function logoSvg(x: number, y: number, width: number): string {
  if (!logo) {
    const file = readFileSync(root("site/assets/whichsitesuse-logo-light.svg"), "utf8");
    const viewBox = /viewBox="([^"]+)"/.exec(file)?.[1] ?? "0 0 842.7 97.2";
    const inner = file.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<metadata[\s\S]*?<\/metadata>/g, "");
    logo = `<svg viewBox="${viewBox}" ${"%POS%"}>${inner}</svg>`;
  }
  const [, , w, h] = (/viewBox="([^"]+)"/.exec(logo)?.[1] ?? "0 0 842.7 97.2").split(/\s+/).map(Number);
  const height = (width * (h ?? 97.2)) / (w ?? 842.7);
  return logo.replace("%POS%", `x="${x}" y="${y}" width="${width}" height="${height.toFixed(1)}"`);
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Greedy wrap by an average glyph width; Geist SemiBold runs about 0.56em per character. */
export function wrap(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * 0.56)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > perLine && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s*\S*$/, "")}…`;
    return kept;
  }
  return lines;
}

export function ogSvg(card: OgCard): string {
  const pad = 72;
  const hasIcon = Boolean(card.icon);
  const titleX = hasIcon ? pad + 132 : pad;
  const titleWidth = OG_WIDTH - titleX - pad;
  const size = card.title.length <= 22 ? 76 : card.title.length <= 40 ? 64 : 54;
  const lines = wrap(card.title, size, titleWidth, 2);
  const titleTop = 280;
  const titleSvg = lines
    .map((l, i) => `<text x="${titleX}" y="${titleTop + i * size * 1.1}" font-family="Geist" font-weight="600" font-size="${size}" letter-spacing="-1.5" fill="#1b1d21">${xml(l)}</text>`)
    .join("");
  const iconSvg = hasIcon
    ? `<rect x="${pad}" y="${titleTop - 82}" width="108" height="108" fill="#fbfbfc" stroke="#c5cad1"/>
       <image x="${pad + 18}" y="${titleTop - 64}" width="72" height="72" href="data:image/png;base64,${card.icon!.toString("base64")}" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  const statY = 500;
  const stat = card.stat
    ? `<text x="${pad}" y="${statY}" font-family="Geist Mono" font-weight="500" font-size="64" letter-spacing="-3" fill="#1b1d21">${xml(card.stat)}</text>
       <text x="${pad}" y="${statY + 48}" font-family="Geist" font-weight="400" font-size="30" fill="#5c626a">${xml(card.statLabel ?? "")}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#f5f6f7"/>
  <rect x="0" y="0" width="${OG_WIDTH}" height="10" fill="#ffe14d"/>
  ${logoSvg(pad, 64, 300)}
  <text x="${OG_WIDTH - pad}" y="92" text-anchor="end" font-family="Geist Mono" font-weight="500" font-size="22" letter-spacing="3" fill="#5c626a">${xml(card.eyebrow.toUpperCase())}</text>
  <line x1="${pad}" y1="130" x2="${OG_WIDTH - pad}" y2="130" stroke="#c5cad1" stroke-width="2"/>
  ${iconSvg}
  ${titleSvg}
  ${stat}
  ${card.footnote ? `<text x="${OG_WIDTH - pad}" y="${statY + 48}" text-anchor="end" font-family="Geist Mono" font-weight="500" font-size="20" fill="#5c626a">${xml(card.footnote)}</text>` : ""}
</svg>`;
}

export function ogPng(card: OgCard): Buffer {
  const resvg = new Resvg(ogSvg(card), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Geist" },
    fitTo: { mode: "width", value: OG_WIDTH },
  });
  return resvg.render().asPng();
}
