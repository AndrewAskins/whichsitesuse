import type { Db, DbClient } from "../db/pool.js";
import type { PlanId } from "../billing/plans.js";
import { randomToken, sha256 } from "./tokens.js";

export interface Account {
  id: string;
  email: string;
  email_normalized: string;
  email_domain: string;
  email_verified_at: Date | null;
  status: "active" | "suspended";
  suspended_reason: string | null;
  plan: PlanId | "none";
  plan_status: string | null;
  plan_renews_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  first_paid_at: Date | null;
  is_admin: boolean;
  created_at: Date;
}

export interface ApiKey {
  id: string;
  account_id: string;
  name: string;
  prefix: string;
  monthly_credit_cap: number | null;
  /** Set when the "key" is an OAuth connection approved for an app like Claude or ChatGPT. */
  oauth_client_id: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const ACCOUNT_COLS = `id, email, email_normalized, email_domain, email_verified_at, status, suspended_reason,
  plan, plan_status, plan_renews_at, stripe_customer_id, stripe_subscription_id, first_paid_at, is_admin, created_at`;
const KEY_COLS = `id, account_id, name, prefix, monthly_credit_cap, oauth_client_id, last_used_at, revoked_at, created_at`;

/** Keys look like wsu_live_<random>. The prefix shown in the dashboard is the first 12 characters. */
export const KEY_PREFIX = "wsu_live_";
/** OAuth access tokens, issued to apps like Claude and ChatGPT; they last an hour. */
export const OAUTH_ACCESS_PREFIX = "wsu_oat_";

/** An account that has never paid is on the trial caps. */
export function isTrial(account: Pick<Account, "first_paid_at">): boolean {
  return account.first_paid_at === null;
}

export class Accounts {
  constructor(private readonly db: Db) {}

  async byId(id: string, client: DbClient = this.db): Promise<Account | null> {
    const { rows } = await client.query<Account>(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async byEmail(email: string): Promise<Account | null> {
    const { rows } = await this.db.query<Account>(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  async byNormalizedEmail(normalized: string): Promise<Account | null> {
    const { rows } = await this.db.query<Account>(
      `SELECT ${ACCOUNT_COLS} FROM accounts WHERE email_normalized = $1`,
      [normalized],
    );
    return rows[0] ?? null;
  }

  async byStripeCustomer(customerId: string, client: DbClient = this.db): Promise<Account | null> {
    const { rows } = await client.query<Account>(
      `SELECT ${ACCOUNT_COLS} FROM accounts WHERE stripe_customer_id = $1`,
      [customerId],
    );
    return rows[0] ?? null;
  }

  async create(input: {
    email: string;
    normalized: string;
    domain: string;
    ip?: string | null;
    fingerprintHash?: string | null;
  }): Promise<Account> {
    const { rows } = await this.db.query<Account>(
      `INSERT INTO accounts (email, email_normalized, email_domain, signup_ip, signup_fingerprint_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${ACCOUNT_COLS}`,
      [input.email, input.normalized, input.domain, input.ip ?? null, input.fingerprintHash ?? null],
    );
    return rows[0]!;
  }

  async markVerified(id: string, isAdmin: boolean, client: DbClient = this.db): Promise<Account> {
    const { rows } = await client.query<Account>(
      `UPDATE accounts SET email_verified_at = coalesce(email_verified_at, now()),
              is_admin = is_admin OR $2, updated_at = now()
        WHERE id = $1 RETURNING ${ACCOUNT_COLS}`,
      [id, isAdmin],
    );
    return rows[0]!;
  }

  async setSuspended(id: string, suspended: boolean, reason: string | null, client: DbClient = this.db): Promise<void> {
    await client.query(
      `UPDATE accounts SET status = $2, suspended_reason = $3, updated_at = now() WHERE id = $1`,
      [id, suspended ? "suspended" : "active", suspended ? reason : null],
    );
  }

  // --- API keys -------------------------------------------------------------

  /** Creates a key and returns the full secret once; only its hash is stored. */
  async createKey(accountId: string, name: string, monthlyCap: number | null = null): Promise<{ key: ApiKey; secret: string }> {
    const secret = `${KEY_PREFIX}${randomToken(24)}`;
    const { rows } = await this.db.query<ApiKey>(
      `INSERT INTO api_keys (account_id, name, prefix, key_hash, monthly_credit_cap)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${KEY_COLS}`,
      [accountId, name, secret.slice(0, KEY_PREFIX.length + 4), sha256(secret), monthlyCap],
    );
    return { key: rows[0]!, secret };
  }

  async listKeys(accountId: string): Promise<ApiKey[]> {
    const { rows } = await this.db.query<ApiKey>(
      `SELECT ${KEY_COLS} FROM api_keys WHERE account_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      [accountId],
    );
    return rows;
  }

  async revokeKey(accountId: string, keyId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`,
      [keyId, accountId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeAllKeys(accountId: string, client: DbClient = this.db): Promise<number> {
    const res = await client.query(
      `UPDATE api_keys SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    return res.rowCount ?? 0;
  }

  /** Only the account owner sets a cap, from the dashboard; null removes it. */
  async setKeyCap(accountId: string, keyId: string, cap: number | null): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE api_keys SET monthly_credit_cap = $3 WHERE id = $1 AND account_id = $2`,
      [keyId, accountId, cap],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * The account and key behind a credential: an API key, or an OAuth access token
   * (which resolves to its connection's api_keys row). Null for an unknown, expired
   * or revoked credential.
   */
  async authenticate(secret: string): Promise<{ account: Account; key: ApiKey } | null> {
    let keyId: string | undefined;
    if (secret.startsWith(KEY_PREFIX)) {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id`,
        [sha256(secret)],
      );
      keyId = rows[0]?.id;
    } else if (secret.startsWith(OAUTH_ACCESS_PREFIX)) {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE api_keys k SET last_used_at = now()
           FROM oauth_tokens t
          WHERE t.access_hash = $1 AND t.revoked_at IS NULL AND t.access_expires_at > now()
            AND k.id = t.api_key_id AND k.revoked_at IS NULL
        RETURNING k.id`,
        [sha256(secret)],
      );
      keyId = rows[0]?.id;
    }
    if (!keyId) return null;
    const key = await this.keyById(keyId);
    const account = key ? await this.byId(key.account_id) : null;
    return account && key ? { account, key } : null;
  }

  async keyById(id: string, client: DbClient = this.db): Promise<ApiKey | null> {
    const { rows } = await client.query<ApiKey>(`SELECT ${KEY_COLS} FROM api_keys WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Credits this key has spent in the current UTC calendar month. */
  async keyCreditsThisMonth(keyId: string): Promise<number> {
    const { rows } = await this.db.query<{ used: string | null }>(
      `SELECT sum(credits)::text AS used FROM usage_events
        WHERE api_key_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [keyId],
    );
    return Number(rows[0]?.used ?? 0);
  }
}
