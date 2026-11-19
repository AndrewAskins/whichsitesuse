import { GRANT_SIGNALS } from "../billing/plans.js";
import type { DbClient } from "../db/pool.js";

/**
 * Queries behind the abuse dashboard (spec: "grants per day, grant-to-paid
 * conversion, grants per network and top trial spenders"). Read-only; each
 * function is one query so the page can run them side by side.
 */

/** Days are UTC, like the grants-per-day alert. */
const UTC_TODAY = `date_trunc('day', now() AT TIME ZONE 'UTC')`;

export interface GrantDay {
  day: string;
  granted: number;
  manual: number;
  withheld: number;
  revoked: number;
}

/**
 * Grant decisions per day, newest first, with every day present. Each row is
 * counted on the day it was decided, under the status it has now (a grant
 * revoked later shows as revoked on its original day).
 */
export async function grantsPerDay(db: DbClient, days = 14): Promise<GrantDay[]> {
  const { rows } = await db.query<GrantDay>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(g.id) FILTER (WHERE g.status = 'granted')::int AS granted,
            count(g.id) FILTER (WHERE g.status = 'manual')::int AS manual,
            count(g.id) FILTER (WHERE g.status = 'withheld')::int AS withheld,
            count(g.id) FILTER (WHERE g.status = 'revoked')::int AS revoked
       FROM generate_series(${UTC_TODAY} - make_interval(days => $1 - 1), ${UTC_TODAY}, interval '1 day') AS d(day)
       LEFT JOIN free_grants g
         ON g.created_at >= d.day AT TIME ZONE 'UTC' AND g.created_at < (d.day + interval '1 day') AT TIME ZONE 'UTC'
      GROUP BY d.day ORDER BY d.day DESC`,
    [days],
  );
  return rows;
}

export interface Conversion {
  granted: number;
  paid: number;
  /** paid / granted, 0 to 1; null with no grants. */
  rate: number | null;
}

/** Of the accounts given a grant (automatic or manual) in the window, how many have paid since. */
export async function grantConversion(db: DbClient, days = 30): Promise<Conversion> {
  const { rows } = await db.query<{ granted: number; paid: number }>(
    `SELECT count(*)::int AS granted, count(a.first_paid_at)::int AS paid
       FROM free_grants g JOIN accounts a ON a.id = g.account_id
      WHERE g.status IN ('granted', 'manual') AND g.created_at > now() - make_interval(days => $1)`,
    [days],
  );
  const { granted, paid } = rows[0]!;
  return { granted, paid, rate: granted ? paid / granted : null };
}

export interface NetworkRow {
  network: string;
  grants: number;
  granted: number;
  withheld: number;
  last_at: Date;
}

/** Networks with the most grant rows (any status) in the grant-signal window. */
export async function topNetworks(db: DbClient, limit = 10, days: number = GRANT_SIGNALS.networkWindowDays): Promise<NetworkRow[]> {
  const { rows } = await db.query<NetworkRow>(
    `SELECT ip_prefix::text AS network, count(*)::int AS grants,
            count(*) FILTER (WHERE status IN ('granted', 'manual'))::int AS granted,
            count(*) FILTER (WHERE status = 'withheld')::int AS withheld,
            max(created_at) AS last_at
       FROM free_grants
      WHERE ip_prefix IS NOT NULL AND created_at > now() - make_interval(days => $2)
      GROUP BY ip_prefix ORDER BY grants DESC, last_at DESC LIMIT $1`,
    [limit, days],
  );
  return rows;
}

export interface TrialSpender {
  account_id: string;
  email: string;
  status: string;
  calls: number;
  credits: number;
  balance: number;
}

/** Accounts that have never paid, by credits spent in the window. */
export async function topTrialSpenders(db: DbClient, limit = 10, days = 30): Promise<TrialSpender[]> {
  const { rows } = await db.query<TrialSpender>(
    `SELECT a.id AS account_id, a.email::text AS email, a.status,
            count(*)::int AS calls, sum(u.credits)::int AS credits,
            coalesce((SELECT sum(remaining) FROM credit_lots l
                       WHERE l.account_id = a.id AND l.remaining > 0
                         AND (l.expires_at IS NULL OR l.expires_at > now())), 0)::int AS balance
       FROM usage_events u JOIN accounts a ON a.id = u.account_id
      WHERE a.first_paid_at IS NULL AND u.created_at > now() - make_interval(days => $2)
      GROUP BY a.id HAVING sum(u.credits) > 0
      ORDER BY credits DESC, calls DESC LIMIT $1`,
    [limit, days],
  );
  return rows;
}

export interface SignalRow {
  id: string;
  account_id: string | null;
  email: string | null;
  kind: string;
  ip: string | null;
  ip_prefix: string | null;
  fingerprint_hash: string | null;
  email_domain: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

/** Newest abuse signals, everywhere or for one account. */
export async function recentSignals(db: DbClient, opts: { accountId?: string; limit?: number } = {}): Promise<SignalRow[]> {
  const { rows } = await db.query<SignalRow>(
    `SELECT s.id, s.account_id, a.email::text AS email, s.kind, host(s.ip) AS ip, s.ip_prefix::text AS ip_prefix,
            s.fingerprint_hash, s.email_domain, s.detail, s.created_at
       FROM abuse_signals s LEFT JOIN accounts a ON a.id = s.account_id
      WHERE ($1::uuid IS NULL OR s.account_id = $1)
      ORDER BY s.created_at DESC, s.id DESC LIMIT $2`,
    [opts.accountId ?? null, opts.limit ?? 50],
  );
  return rows;
}

export interface AlertRow {
  id: string;
  kind: string;
  dedupe_key: string;
  subject: string | null;
  created_at: Date;
}

export async function recentAlerts(db: DbClient, limit = 20): Promise<AlertRow[]> {
  const { rows } = await db.query<AlertRow>(
    `SELECT id, kind, dedupe_key, detail->>'subject' AS subject, created_at
       FROM admin_alerts ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function pendingRequestCount(db: DbClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM free_credit_requests WHERE status = 'pending'`,
  );
  return rows[0]!.n;
}

export interface Dashboard {
  days: GrantDay[];
  conversion: Conversion;
  networks: NetworkRow[];
  spenders: TrialSpender[];
  signals: SignalRow[];
  alerts: AlertRow[];
  pendingRequests: number;
}

/** Everything the dashboard shows, in parallel. */
export async function loadDashboard(db: DbClient): Promise<Dashboard> {
  const [days, conversion, networks, spenders, signals, alerts, pendingRequests] = await Promise.all([
    grantsPerDay(db),
    grantConversion(db),
    topNetworks(db),
    topTrialSpenders(db),
    recentSignals(db),
    recentAlerts(db),
    pendingRequestCount(db),
  ]);
  return { days, conversion, networks, spenders, signals, alerts, pendingRequests };
}
