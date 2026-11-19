import type pg from "pg";
import { GRANT_SIGNALS } from "../billing/plans.js";
import { log } from "../log.js";
import type { Services } from "../services.js";

/**
 * Abuse signals and admin alerts for the free grant (spec: "Free-credit abuse
 * controls"). Signals are the raw record the admin pages read; alerts are the
 * few events worth an email, sent at most once per dedupe key.
 */

export type SignalKind =
  | "disposable_signup"
  | "grant_withheld_not_work_email"
  | "grant_withheld_already_granted"
  | "grant_withheld_network"
  | "grant_withheld_device"
  | "turnstile_failed"
  // Open-ended so a new check can record a signal without touching this file.
  | (string & {});

export interface Signal {
  accountId?: string | null;
  kind: SignalKind;
  ip?: string | null;
  /** A network, e.g. "203.0.113.0/24". Host bits are masked, so an address with a mask works too. */
  ipPrefix?: string | null;
  fingerprintHash?: string | null;
  emailDomain?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Records one abuse signal. Pass the sign-up transaction's client to record it
 * with the decision it explains; errors are thrown, as for any write in it.
 */
export async function recordSignal(services: Services, signal: Signal, client: pg.PoolClient | pg.Pool = services.db): Promise<void> {
  await client.query(
    `INSERT INTO abuse_signals (account_id, kind, ip, ip_prefix, fingerprint_hash, email_domain, detail)
     VALUES ($1, $2, $3::inet, network($4::inet), $5, $6, $7)`,
    [
      signal.accountId ?? null,
      signal.kind,
      signal.ip ?? null,
      signal.ipPrefix ?? null,
      signal.fingerprintHash ?? null,
      signal.emailDomain ?? null,
      JSON.stringify(signal.detail ?? {}),
    ],
  );
}

/**
 * Records an alert and emails it to ADMIN_ALERT_EMAIL. Returns false when an
 * alert with this dedupe key was already recorded, so callers can fire on
 * every event and the admin still hears once. A failed email is logged, not
 * thrown: the alert stays on the dashboard either way.
 */
export async function alertAdmin(
  services: Services,
  kind: string,
  dedupeKey: string,
  subject: string,
  text: string,
): Promise<boolean> {
  const { rowCount } = await services.db.query(
    `INSERT INTO admin_alerts (kind, dedupe_key, detail) VALUES ($1, $2, $3)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [kind, dedupeKey, JSON.stringify({ subject, text })],
  );
  if (!rowCount) return false;
  const to = services.config.ADMIN_ALERT_EMAIL;
  if (to) {
    try {
      await services.mailer.send({ to, template: "adminAlert", data: { subject, text }, subject: `[WhichSitesUse] ${subject}`, text });
    } catch (err) {
      log.error({ err, kind, dedupeKey }, "admin alert email failed");
    }
  }
  return true;
}

/**
 * Runs after each grant decision. Alerts once per UTC day when automatic grants
 * pass ALERT_GRANTS_PER_DAY, and once per network per day when one network has
 * more grant rows (any status) than GRANT_SIGNALS.maxGrantsPerNetwork in the
 * window. Best effort: a failure is logged so it never breaks a sign-up.
 */
export async function checkGrantAlerts(services: Services, ipPrefix: string | null): Promise<void> {
  try {
    const { rows } = await services.db.query<{ day: string; granted: number; network: string | null; network_rows: number }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM free_grants
                WHERE status = 'granted'
                  AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS granted,
              network($1::inet)::text AS network,
              (SELECT count(*)::int FROM free_grants
                WHERE $1::inet IS NOT NULL AND ip_prefix = network($1::inet)
                  AND created_at > now() - make_interval(days => $2)) AS network_rows`,
      [ipPrefix, GRANT_SIGNALS.networkWindowDays],
    );
    const r = rows[0]!;
    const limit = services.config.ALERT_GRANTS_PER_DAY;

    if (r.granted > limit) {
      await alertAdmin(
        services,
        "grants_per_day",
        `grants-per-day:${r.day}`,
        `${r.granted} free grants today`,
        `${r.granted} free grants have gone out today (${r.day} UTC), past the alert threshold of ${limit}.\n\n` +
          `Review them at ${services.config.PUBLIC_BASE_URL}/admin`,
      );
    }

    if (r.network && r.network_rows > GRANT_SIGNALS.maxGrantsPerNetwork) {
      await alertAdmin(
        services,
        "grants_per_network",
        `grants-per-network:${r.network}:${r.day}`,
        `${r.network_rows} free-grant sign-ups from ${r.network}`,
        `${r.network_rows} free-grant sign-ups came from ${r.network} in the last ${GRANT_SIGNALS.networkWindowDays} days ` +
          `(more than ${GRANT_SIGNALS.maxGrantsPerNetwork} withholds the grant until a card is added).\n\n` +
          `Review them at ${services.config.PUBLIC_BASE_URL}/admin`,
      );
    }
  } catch (err) {
    log.error({ err, ipPrefix }, "grant alert check failed");
  }
}
