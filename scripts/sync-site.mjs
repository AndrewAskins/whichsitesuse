// Copies the shared head, header and footer into every page in site/.
// Each page marks the spots with <!-- @partial NAME --> ... <!-- @end NAME -->, and the
// content between the markers always comes from scripts/site-partials/NAME.html (the one source).
// Usage: node scripts/sync-site.mjs        rewrite pages
//        node scripts/sync-site.mjs --check exit 1 if any page is out of date
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const siteDir = join(root, "site");
const partialDir = join(root, "scripts", "site-partials");

export function pages(dir = siteDir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name.endsWith(".html") ? [path] : [];
  });
}

export function syncPage(html, partials) {
  return html.replace(/( *)<!-- @partial ([a-z-]+) -->\n[\s\S]*?\1<!-- @end \2 -->\n/g, (match, indent, name) => {
    const body = partials[name];
    if (body === undefined) throw new Error(`Unknown partial "${name}"`);
    return `${indent}<!-- @partial ${name} -->\n${body}${indent}<!-- @end ${name} -->\n`;
  });
}

export function loadPartials() {
  return Object.fromEntries(
    readdirSync(partialDir).filter((f) => f.endsWith(".html")).map((f) => [f.replace(/\.html$/, ""), readFileSync(join(partialDir, f), "utf8")]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const partials = loadPartials();
  const stale = [];
  for (const page of pages()) {
    const html = readFileSync(page, "utf8");
    const next = syncPage(html, partials);
    if (next === html) continue;
    stale.push(relative(root, page));
    if (!check) writeFileSync(page, next);
  }
  if (check && stale.length) {
    console.error(`Shared partials are out of date in:\n  ${stale.join("\n  ")}\nRun: npm run site:sync`);
    process.exit(1);
  }
  console.log(check ? "Site partials are in sync." : `Updated ${stale.length} page(s).`);
}
