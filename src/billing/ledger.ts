import type pg from "pg";
import { isUniqueViolation, withTransaction, type Db, type DbClient } from "../db/pool.js";

export type Bucket = "trial" | "plan" | "topup";
export type LedgerKind = "grant" | "plan" | "topup" | "spend" | "refund" | "expire" | "revoke" | "adjust";

export interface Balance {
  total: number;
  trial: number;
  plan: number;
  topup: number;
  /** Soonest expiry among spendable plan credits (the plan's renewal), if any. */
  plan_expires_at: string | null;
}

/** Spend order: plan credits first (they reset monthly), then top-ups, then the free grant. */
const SPEND_ORDER = `CASE bucket WHEN 'plan' THEN 0 WHEN 'topup' THEN 1 ELSE 2 END, expires_at NULLS LAST, id`;
const SPENDABLE = `remaining > 0 AND (expires_at IS NULL OR expires_at > now())`;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(`Needs ${needed} credits, ${available} available`);
  }
}

export interface AddLotInput {
  accountId: string;
  bucket: Bucket;
  kind: LedgerKind;
  credits: number;
  expiresAt?: Date | null;
  /** Stripe or grant reference. A (kind, ref) pair adds credits once only. */
  ref?: string | null;
  note?: string | null;
  createdBy?: string;
}

/**
 * The credit ledger. Credits sit in lots (each with its own bucket and
 * expiry); every change to a lot also writes an append-only ledger row.
 */
export class Ledger {
  constructor(private readonly db: Db) {}

  async balance(accountId: string, client: DbClient = this.db): Promise<Balance> {
    const { rows } = await client.query<{ bucket: Bucket; remaining: string; expires: string | null }>(
      `SELECT bucket, sum(remaining)::text AS remaining, min(expires_at)::text AS expires
         FROM credit_lots WHERE account_id = $1 AND ${SPENDABLE} GROUP BY bucket`,
      [accountId],
    );
    const b: Balance = { total: 0, trial: 0, plan: 0, topup: 0, plan_expires_at: null };
    for (const r of rows) {
      const n = Number(r.remaining);
      b[r.bucket] = n;
      b.total += n;
      if (r.bucket === "plan") b.plan_expires_at = r.expires ? new Date(r.expires).toISOString() : null;
    }
    return b;
  }

  /**
   * Adds a lot. Returns false (and changes nothing) when this (kind, ref) was
   * already recorded, so replayed webhooks can't add credits twice.
   */
  async addLot(input: AddLotInput, client?: pg.PoolClient): Promise<boolean> {
    const run = async (c: pg.PoolClient) => {
      await c.query("SAVEPOINT add_lot");
      try {
        const lot = await c.query<{ id: string }>(
          `INSERT INTO credit_lots (account_id, bucket, original, remaining, expires_at)
           VALUES ($1, $2, $3, $3, $4) RETURNING id`,
          [input.accountId, input.bucket, input.credits, input.expiresAt ?? null],
        );
        await c.query(
          `INSERT INTO credit_ledger (account_id, lot_id, kind, amount, ref, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [input.accountId, lot.rows[0]!.id, input.kind, input.credits, input.ref ?? null, input.note ?? null, input.createdBy ?? "system"],
        );
        await c.query("RELEASE SAVEPOINT add_lot");
        return true;
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT add_lot");
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    };
    return client ? run(client) : withTransaction(this.db, run);
  }

  /**
   * Spends credits across lots in spend order, all or nothing. Throws
   * InsufficientCreditsError if the balance dropped below `credits`.
   */
  async spend(accountId: string, credits: number, ref: string, client?: pg.PoolClient): Promise<Balance> {
    if (credits <= 0) return this.balance(accountId, client);
    const run = async (c: pg.PoolClient) => {
      const lots = await c.query<{ id: string; remaining: number }>(
        `SELECT id, remaining FROM credit_lots WHERE account_id = $1 AND ${SPENDABLE}
          ORDER BY ${SPEND_ORDER} FOR UPDATE`,
        [accountId],
      );
      const available = lots.rows.reduce((s, l) => s + l.remaining, 0);
      if (available < credits) throw new InsufficientCreditsError(credits, available);
      let left = credits;
      for (const lot of lots.rows) {
        if (left === 0) break;
        const take = Math.min(lot.remaining, left);
        left -= take;
        await c.query("UPDATE credit_lots SET remaining = remaining - $2 WHERE id = $1", [lot.id, take]);
        await c.query(
          `INSERT INTO credit_ledger (account_id, lot_id, kind, amount, ref) VALUES ($1, $2, 'spend', $3, $4)`,
          [accountId, lot.id, -take, ref],
        );
      }
      return this.balance(accountId, c);
    };
    return client ? run(client) : withTransaction(this.db, run);
  }

  /** Zeroes the unspent credits in a bucket (or all buckets), writing one ledger row per lot. */
  async clearBucket(
    accountId: string,
    kind: "expire" | "revoke",
    opts: { bucket?: Bucket; note?: string; createdBy?: string; ref?: string } = {},
    client?: pg.PoolClient,
  ): Promise<number> {
    const run = async (c: pg.PoolClient) => {
      const lots = await c.query<{ id: string; remaining: number }>(
        `UPDATE credit_lots l SET remaining = 0
           FROM (SELECT id, remaining FROM credit_lots
                  WHERE account_id = $1 AND remaining > 0 AND ($2::text IS NULL OR bucket = $2) FOR UPDATE) old
          WHERE l.id = old.id
        RETURNING l.id, old.remaining`,
        [accountId, opts.bucket ?? null],
      );
      for (const lot of lots.rows) {
        await c.query(
          `INSERT INTO credit_ledger (account_id, lot_id, kind, amount, ref, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [accountId, lot.id, kind, -lot.remaining, opts.ref ?? null, opts.note ?? null, opts.createdBy ?? "system"],
        );
      }
      return lots.rows.reduce((s, l) => s + l.remaining, 0);
    };
    return client ? run(client) : withTransaction(this.db, run);
  }

  /** Writes "expire" rows for lots past their expiry. Run hourly. */
  async sweepExpired(): Promise<number> {
    return withTransaction(this.db, async (c) => {
      const lots = await c.query<{ id: string; account_id: string; remaining: number }>(
        `UPDATE credit_lots l SET remaining = 0
           FROM (SELECT id, account_id, remaining FROM credit_lots
                  WHERE remaining > 0 AND expires_at <= now() FOR UPDATE) old
          WHERE l.id = old.id
        RETURNING l.id, old.account_id, old.remaining`,
      );
      for (const lot of lots.rows) {
        await c.query(
          `INSERT INTO credit_ledger (account_id, lot_id, kind, amount) VALUES ($1, $2, 'expire', $3)`,
          [lot.account_id, lot.id, -lot.remaining],
        );
      }
      return lots.rowCount ?? 0;
    });
  }

  async history(accountId: string, limit = 50) {
    const { rows } = await this.db.query<{
      id: string; kind: LedgerKind; amount: number; ref: string | null; note: string | null; created_by: string; created_at: Date;
    }>(
      `SELECT id, kind, amount, ref, note, created_by, created_at FROM credit_ledger
        WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows;
  }
}
