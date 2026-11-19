import { randomBytes } from "node:crypto";
import pg from "pg";
import type Stripe from "stripe";
import { migrate } from "../../src/db/migrate.js";
import { createPool, type Db } from "../../src/db/pool.js";
import type { Config } from "../../src/config.js";
import { LogMailer } from "../../src/mail/mailer.js";
import { createServices, type Services } from "../../src/services.js";
import { testConfig } from "./config.js";

/** Set by CI (and locally, if you have Postgres). Database tests skip without it. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDb {
  services: Services;
  mailer: LogMailer;
  db: Db;
  config: Config;
  drop(): Promise<void>;
}

/** A fresh, migrated database per test file, dropped afterwards. */
export async function createTestDb(opts: { config?: Record<string, string>; stripe?: Stripe | null } = {}): Promise<TestDb> {
  const base = new URL(TEST_DATABASE_URL!);
  const name = `wsu_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const db = createPool(url.toString());
  const config = testConfig({ DATABASE_URL: url.toString(), ...opts.config });
  const mailer = new LogMailer();
  const services = createServices(config, db, mailer, opts.stripe ?? null);
  return {
    services,
    mailer,
    db,
    config,
    async drop() {
      await db.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** A verified account, optionally with credits in a bucket and a paid flag. */
export async function makeAccount(
  services: Services,
  email: string,
  opts: { credits?: number; bucket?: "trial" | "plan" | "topup"; paid?: boolean; admin?: boolean } = {},
) {
  const [local, domain] = email.split("@") as [string, string];
  const account = await services.accounts.create({ email, normalized: `${local}@${domain}`, domain });
  await services.accounts.markVerified(account.id, opts.admin ?? false);
  if (opts.paid) await services.db.query("UPDATE accounts SET first_paid_at = now() WHERE id = $1", [account.id]);
  if (opts.credits) {
    await services.ledger.addLot({
      accountId: account.id,
      bucket: opts.bucket ?? "topup",
      kind: opts.bucket === "trial" ? "grant" : opts.bucket === "plan" ? "plan" : "topup",
      credits: opts.credits,
    });
  }
  const { key, secret } = await services.accounts.createKey(account.id, "test");
  return { account: (await services.accounts.byId(account.id))!, key, secret };
}
