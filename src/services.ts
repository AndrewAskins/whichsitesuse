import type Stripe from "stripe";
import { Accounts } from "./auth/accounts.js";
import type { MetadataFetcher } from "./auth/cimd.js";
import { Ledger } from "./billing/ledger.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { Mailer } from "./mail/mailer.js";

/**
 * Everything backed by the app database. Built once in index.ts (or a test)
 * and handed to the app; null when the service runs without DATABASE_URL.
 */
export interface Services {
  config: Config;
  db: Db;
  accounts: Accounts;
  ledger: Ledger;
  mailer: Mailer;
  /** Null until STRIPE_SECRET_KEY is set; checkout then answers billing_unavailable. */
  stripe: Stripe | null;
  /** How OAuth client metadata documents are fetched. Defaults to cimd.ts's safeFetch; tests swap it. */
  fetchClientMetadata?: MetadataFetcher;
}

export function createServices(config: Config, db: Db, mailer: Mailer, stripe: Stripe | null): Services {
  return { config, db, accounts: new Accounts(db), ledger: new Ledger(db), mailer, stripe };
}
