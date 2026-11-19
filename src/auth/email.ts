/**
 * Email normalization, so one inbox is one person: lowercased, and for
 * providers that ignore them, dots removed; +tags are always removed.
 */

/** Providers that deliver "a.b+x@" to "ab@". Googlemail is the same inbox as Gmail. */
const DOTS_IGNORED = new Set(["gmail.com", "googlemail.com"]);
const ALIASES: Record<string, string> = { "googlemail.com": "gmail.com", "pm.me": "proton.me", "protonmail.com": "proton.me" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedEmail {
  email: string;
  normalized: string;
  domain: string;
}

export function parseEmail(raw: string): ParsedEmail | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  const rawDomain = email.slice(at + 1).replace(/\.$/, "");
  // Most providers deliver +tags to the same inbox, so strip them everywhere. The
  // normalized address is only used to tell people apart; mail goes to `email`.
  local = local.split("+")[0]!;
  if (DOTS_IGNORED.has(rawDomain)) local = local.replaceAll(".", "");
  if (!local) return null;
  const domain = ALIASES[rawDomain] ?? rawDomain;
  return { email, normalized: `${local}@${domain}`, domain };
}

/**
 * The registrable part of a domain, for matching against block and allow lists
 * ("mail.acme.co.uk" matches a list entry "acme.co.uk"). Returns every suffix
 * with at least two labels, longest first.
 */
export function domainCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}
