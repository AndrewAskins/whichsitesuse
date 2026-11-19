import { log } from "../log.js";
import type { Services } from "../services.js";
import { domainCandidates } from "./email.js";

/**
 * Disposable and free-mail domains. The maintained lists below are pulled
 * weekly into blocked_email_domains; the seeds cover the big providers before
 * the first refresh (and if a refresh ever fails).
 */
export const LIST_SOURCES = {
  disposable:
    "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf",
  freemail: "https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json",
} as const;

const SEED_FREEMAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "hey.com", "fastmail.com", "tutanota.com",
  "tuta.io", "outlook.es", "hotmail.es", "hotmail.fr", "live.fr", "orange.fr", "laposte.net", "libero.it",
  "comcast.net", "att.net", "verizon.net", "sbcglobal.net", "naver.com", "rediffmail.com",
];
const SEED_DISPOSABLE = [
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "10minutemail.com", "temp-mail.org",
  "tempmail.com", "yopmail.com", "trashmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com",
  "mailnesia.com", "fakeinbox.com", "tempail.com", "emailondeck.com", "mohmal.com", "mintemail.com", "spamgourmet.com",
];

const SEEDS = new Map<string, "disposable" | "freemail">([
  ...SEED_FREEMAIL.map((d) => [d, "freemail"] as const),
  ...SEED_DISPOSABLE.map((d) => [d, "disposable"] as const),
]);

export type DomainStatus = "allowed" | "disposable" | "freemail" | "work";

/**
 * How a sign-up's email domain is treated: "allowed" (approved by an admin
 * after a false positive), "disposable" (sign-up refused), "freemail" (can
 * sign up and pay, but no free grant) or "work".
 */
export async function emailDomainStatus(services: Services, domain: string): Promise<DomainStatus> {
  const candidates = domainCandidates(domain);
  const allowed = await services.db.query(`SELECT 1 FROM allowed_email_domains WHERE domain = ANY($1) LIMIT 1`, [candidates]);
  if (allowed.rowCount) return "allowed";
  const { rows } = await services.db.query<{ list: "disposable" | "freemail" }>(
    `SELECT list FROM blocked_email_domains WHERE domain = ANY($1)`,
    [candidates],
  );
  const lists = new Set([...rows.map((r) => r.list), ...candidates.map((c) => SEEDS.get(c)).filter(Boolean)]);
  if (lists.has("disposable")) return "disposable";
  if (lists.has("freemail")) return "freemail";
  return "work";
}

export function parseDisposable(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#") && l.includes("."));
}

export function parseFreemail(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("free-mail list is not a JSON array");
  return parsed.filter((d): d is string => typeof d === "string" && d.includes(".")).map((d) => d.toLowerCase());
}

/**
 * Replaces each list's rows with the current upstream copy. A list that fails
 * to download or comes back suspiciously short is left as it was.
 */
export async function refreshEmailLists(services: Services, fetcher: typeof fetch = fetch): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [list, url] of Object.entries(LIST_SOURCES) as [keyof typeof LIST_SOURCES, string][]) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const domains = [...new Set(list === "disposable" ? parseDisposable(text) : parseFreemail(text))];
      if (domains.length < 500) throw new Error(`only ${domains.length} domains`);
      const client = await services.db.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM blocked_email_domains WHERE list = $1 AND source = $2", [list, url]);
        // A domain on both lists stays disposable (the stricter one).
        await client.query(
          `INSERT INTO blocked_email_domains (domain, list, source)
           SELECT d, $2, $3 FROM unnest($1::text[]) AS d
           ON CONFLICT (domain) DO UPDATE SET
             list = CASE WHEN blocked_email_domains.list = 'disposable' THEN 'disposable' ELSE EXCLUDED.list END,
             source = CASE WHEN blocked_email_domains.list = 'disposable' THEN blocked_email_domains.source ELSE EXCLUDED.source END,
             updated_at = now()`,
          [domains, list, url],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      counts[list] = domains.length;
    } catch (err) {
      log.warn({ err, list }, "email domain list not refreshed");
    }
  }
  return counts;
}

/** True when the lists are missing or older than a week. */
export async function emailListsStale(services: Services): Promise<boolean> {
  const { rows } = await services.db.query<{ n: string; newest: Date | null }>(
    `SELECT count(*)::text AS n, max(updated_at) AS newest FROM blocked_email_domains`,
  );
  const r = rows[0]!;
  return Number(r.n) < 1000 || !r.newest || Date.now() - r.newest.getTime() > 7 * 86400_000;
}
