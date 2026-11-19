/**
 * Server-rendered pages in the Moonlight design system (spec: "Design system:
 * Moonlight"): black and white, hard edges, mono headlines, one moon-yellow
 * highlight. No client framework; forms post back to the server.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A trusted HTML fragment, so templates can nest without double escaping. */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

/** Tagged template: interpolated values are escaped unless they are Html (or arrays of Html). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export const raw = (s: string) => new Html(s);

const CSS = `
:root{--bg:#FFFFFF;--ink:#0B0B0B;--muted:#6E6E6E;--line:#E8E8E8;--strong:#0B0B0B;--moon:#FFE14D}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0B;--ink:#F2F2F2;--muted:#8C8C8C;--line:#242424;--strong:#F2F2F2;--moon:#F2D04B}}
*{box-sizing:border-box;border-radius:0}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Geist,ui-sans-serif,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 16px 96px}
header.top{display:flex;justify-content:space-between;align-items:center;max-width:860px;margin:0 auto;padding:24px 16px;border-bottom:1px solid var(--line)}
header.top a{color:var(--ink);text-decoration:none}
.brand{font:700 18px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:-.045em}
nav a{font:500 13px "JetBrains Mono",ui-monospace,monospace;margin-left:16px}
h1{font:700 40px/1.05 "JetBrains Mono",ui-monospace,monospace;letter-spacing:-.045em;margin:0 0 24px}
h2{font:700 22px/1.1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:-.03em;margin:48px 0 16px}
.mark{background:var(--moon);color:#0B0B0B;padding:0 .15em}
.label{font:500 11px "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.muted{color:var(--muted)}
a{color:var(--ink)}
code,.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:14px}
form{margin:0}
label{display:block;margin:16px 0 8px}
input,select,textarea{width:100%;max-width:480px;background:var(--bg);color:var(--ink);border:1.5px solid var(--strong);padding:10px 12px;font:15px "JetBrains Mono",ui-monospace,monospace}
textarea{min-height:96px}
button,.button{display:inline-block;background:var(--ink);color:var(--bg);border:1.5px solid var(--ink);padding:10px 16px;font:500 14px "JetBrains Mono",ui-monospace,monospace;text-transform:lowercase;cursor:pointer;text-decoration:none;margin-top:16px}
button.secondary,.button.secondary{background:transparent;color:var(--ink);border-color:var(--strong)}
button.small{padding:4px 10px;margin:0;font-size:12px}
table{width:100%;border-collapse:collapse;border:1.5px solid var(--strong);margin:16px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{font:500 11px "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.notice{border:1.5px solid var(--strong);padding:16px;margin:24px 0}
.notice.ok{background:var(--moon);color:#0B0B0B;border-color:#0B0B0B}
.stats{display:flex;flex-wrap:wrap;gap:16px;margin:16px 0}
.stat{border:1.5px solid var(--strong);padding:16px;min-width:160px}
.stat b{display:block;font:700 28px "JetBrains Mono",ui-monospace,monospace;letter-spacing:-.03em}
.inline{display:inline}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.row input,.row select{width:auto}
.secret{font:500 15px "JetBrains Mono",ui-monospace,monospace;background:var(--moon);color:#0B0B0B;padding:12px;word-break:break-all}
`;

export interface PageOptions {
  title: string;
  body: Html;
  /** Signed-in pages show account links in the header. */
  signedIn?: boolean;
  isAdmin?: boolean;
  /** Extra tags for <head>, e.g. the Turnstile script. */
  head?: Html;
}

export function page({ title, body, signedIn, isAdmin, head }: PageOptions): string {
  return `<!doctype html>${html`<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · WhichSitesUse</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${raw(CSS)}</style>${head ?? ""}
</head><body>
<header class="top"><a class="brand" href="/">whichsitesuse<span class="mark">_</span></a>
<nav>${
    signedIn
      ? html`<a href="/account">account</a>${isAdmin ? html`<a href="/admin">admin</a>` : ""}<form class="inline" method="post" action="/logout"><button class="secondary small" style="margin-left:16px">sign out</button></form>`
      : html`<a href="/login">sign in</a><a href="/signup">sign up</a>`
  }</nav></header>
<main>${body}</main></body></html>`}`;
}

/** A hidden CSRF field for every POST form on a signed-in page. */
export function csrfField(token: string): Html {
  return html`<input type="hidden" name="csrf" value="${token}">`;
}

export function notice(message: string | Html | undefined, kind: "ok" | "info" = "info"): Html {
  return message ? html`<div class="notice ${kind === "ok" ? "ok" : ""}">${message}</div>` : html``;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

export function fmtNum(n: number | string | null | undefined): string {
  return Number(n ?? 0).toLocaleString("en-US");
}
