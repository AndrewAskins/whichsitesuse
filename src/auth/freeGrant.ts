import type pg from "pg";
import { checkGrantAlerts, recordSignal } from "../abuse/alerts.js";
import { FREE_GRANT, GRANT_SIGNALS } from "../billing/plans.js";
import { withTransaction } from "../db/pool.js";
import type { Services } from "../services.js";
import type { Account } from "./accounts.js";
import { emailDomainStatus } from "./emailLists.js";

/** Outcome of the free-grant check at email verification. */
export type GrantDecision =
  | { status: "granted"; credits: number }
  | { status: "withheld"; reason: GrantWithheldReason }
  | { status: "manual" | "revoked"; credits: number };

export type GrantWithheldReason = "not_work_email" | "already_granted" | "network" | "device";

/** Withheld for these reasons, the grant is released by a first payment ("until a card is added"). */
const RELEASED_BY_PAYMENT: GrantWithheldReason[] = ["network", "device"];

/** IPv4 /24 or IPv6 /48, the "network" in "more than two grants from one network". */
const IP_PREFIX = `network(set_masklen($1::inet, CASE WHEN family($1::inet) = 4 THEN 24 ELSE 48 END))::cidr`;

/**
 * Runs the free-grant checks once, when an account first verifies its email,
 * and grants or withholds the 250 credits. Signals come from sign-up: the IP
 * and the (HMAC'd) browser fingerprint. Idempotent: a second call returns the
 * first decision.
 */
export async function decideFreeGrant(services: Services, account: Account): Promise<GrantDecision> {
  const existing = await currentGrant(services, account.id);
  if (existing) return existing;

  const { rows } = await services.db.query<{ ip: string | null; fp: string | null; prefix: string | null }>(
    `SELECT signup_ip::text AS ip, signup_fingerprint_hash AS fp,
            CASE WHEN signup_ip IS NULL THEN NULL ELSE ${IP_PREFIX.replaceAll("$1", "signup_ip")}::text END AS prefix
       FROM accounts WHERE id = $1`,
    [account.id],
  );
  const { ip, fp, prefix } = rows[0] ?? { ip: null, fp: null, prefix: null };

  const domain = await emailDomainStatus(services, account.email_domain);

  // One decision at a time: the device and network checks count earlier grants, so two
  // verifications racing each other must not both see "none yet" (they are rare, so one
  // lock for all of them costs nothing).
  const decision = await withTransaction(services.db, async (c): Promise<GrantDecision> => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [GRANT_DECISION_LOCK]);
    const already = await c.query(`SELECT 1 FROM free_grants WHERE account_id = $1`, [account.id]);
    if (already.rowCount) return (await currentGrant(services, account.id, c))!;
    const reason = domain === "work" || domain === "allowed" ? await withheldReason(c, account, fp, prefix) : "not_work_email";
    if (reason) {
      await c.query(
        `INSERT INTO free_grants (account_id, email_normalized, status, reason, credits, ip, ip_prefix, fingerprint_hash)
         VALUES ($1, $2, 'withheld', $3, 0, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [account.id, account.email_normalized, reason, ip, prefix, fp],
      );
      return { status: "withheld", reason };
    }
    await c.query(
      `INSERT INTO free_grants (account_id, email_normalized, status, credits, ip, ip_prefix, fingerprint_hash)
       VALUES ($1, $2, 'granted', $3, $4, $5, $6)`,
      [account.id, account.email_normalized, FREE_GRANT.credits, ip, prefix, fp],
    );
    await addGrantLot(services, account.id, "system", c);
    return { status: "granted", credits: FREE_GRANT.credits };
  });

  if (decision.status === "withheld") {
    await recordSignal(services, {
      accountId: account.id,
      kind: `grant_withheld_${decision.reason}`,
      ip,
      ipPrefix: prefix,
      fingerprintHash: fp,
      emailDomain: account.email_domain,
    });
  }
  await checkGrantAlerts(services, prefix);
  return decision;
}

/** Advisory lock key that serializes free-grant decisions. */
const GRANT_DECISION_LOCK = 727002;

/** Checks run inside the decision's transaction, after the work-email check. */
async function withheldReason(
  c: pg.PoolClient,
  account: Account,
  fingerprint: string | null,
  prefix: string | null,
): Promise<GrantWithheldReason | null> {
  // One grant per person: the same inbox (normalized) can't have had one on another account.
  const sameEmail = await c.query(
    `SELECT 1 FROM free_grants WHERE email_normalized = $1 AND account_id <> $2 LIMIT 1`,
    [account.email_normalized, account.id],
  );
  if (sameEmail.rowCount) return "already_granted";

  if (fingerprint) {
    const sameDevice = await c.query(
      `SELECT 1 FROM free_grants WHERE fingerprint_hash = $1 AND status IN ('granted', 'manual') LIMIT 1`,
      [fingerprint],
    );
    if (sameDevice.rowCount) return "device";
  }

  if (prefix) {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM free_grants
        WHERE ip_prefix = $1::cidr AND status IN ('granted', 'manual')
          AND created_at > now() - make_interval(days => $2)`,
      [prefix, GRANT_SIGNALS.networkWindowDays],
    );
    if (Number(rows[0]!.n) >= GRANT_SIGNALS.maxGrantsPerNetwork) return "network";
  }
  return null;
}

export async function currentGrant(
  services: Services,
  accountId: string,
  client: pg.PoolClient | pg.Pool = services.db,
): Promise<GrantDecision | null> {
  const { rows } = await client.query<{ status: string; reason: string | null; credits: number }>(
    `SELECT status, reason, credits FROM free_grants WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === "withheld") return { status: "withheld", reason: row.reason as GrantWithheldReason };
  return { status: row.status as "granted" | "manual" | "revoked", credits: row.credits };
}

/**
 * Gives the one-time free grant (trial bucket, ledger kind "grant", ref
 * "grant:<accountId>") and records it in free_grants with the given status.
 * Idempotent: returns false and adds nothing when the account already had it.
 * `by` is "system" or the admin's email.
 */
export async function grantFreeCredits(
  services: Services,
  accountId: string,
  opts: { status: "granted" | "manual"; by: string; reason?: string },
  client?: pg.PoolClient,
): Promise<boolean> {
  const run = async (c: pg.PoolClient) => {
    const account = await services.accounts.byId(accountId, c);
    if (!account) throw new Error(`No account ${accountId}`);
    // Already had it (even if later revoked): change nothing, so the record stays true.
    const had = await c.query(`SELECT 1 FROM credit_ledger WHERE kind = 'grant' AND ref = $1`, [`grant:${accountId}`]);
    if (had.rowCount) return false;
    // Keep why it was first withheld (e.g. not_work_email) unless a new reason is given.
    await c.query(
      `INSERT INTO free_grants (account_id, email_normalized, status, reason, credits)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id) DO UPDATE SET status = EXCLUDED.status,
         reason = coalesce(EXCLUDED.reason, free_grants.reason), credits = EXCLUDED.credits`,
      [accountId, account.email_normalized, opts.status, opts.reason ?? null, FREE_GRANT.credits],
    );
    return addGrantLot(services, accountId, opts.by, c);
  };
  return client ? run(client) : withTransaction(services.db, run);
}

function addGrantLot(services: Services, accountId: string, by: string, client: pg.PoolClient): Promise<boolean> {
  return services.ledger.addLot(
    {
      accountId,
      bucket: "trial",
      kind: "grant",
      credits: FREE_GRANT.credits,
      ref: `grant:${accountId}`,
      note: "One-time free grant",
      createdBy: by,
    },
    client,
  );
}

/**
 * Called on an account's first successful payment: a grant withheld for
 * network or device signals ("until a card is added") is released.
 */
export async function releaseWithheldGrant(services: Services, accountId: string, client?: pg.PoolClient): Promise<void> {
  const db = client ?? services.db;
  const { rows } = await db.query<{ reason: GrantWithheldReason | null }>(
    `SELECT reason FROM free_grants WHERE account_id = $1 AND status = 'withheld'`,
    [accountId],
  );
  const reason = rows[0]?.reason;
  if (!reason || !RELEASED_BY_PAYMENT.includes(reason)) return;
  await grantFreeCredits(services, accountId, { status: "granted", by: "system", reason: `released_on_payment:${reason}` }, client);
}
