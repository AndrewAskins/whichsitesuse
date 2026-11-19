import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // App database (accounts, keys, credits). Optional so the query service can run read-only.
  DATABASE_URL: z.string().optional(),

  // Snapshot of the monthly dataset, as Parquet files on local disk.
  SNAPSHOT_DIR: z.string().default("./data/snapshot"),

  // Kill switch: when false, rows whose source is "httparchive" are never served.
  SERVE_HTTPARCHIVE: bool.default(true),

  // BigQuery, in the WhichSitesUse Google Cloud project only.
  GCP_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
  BIGQUERY_MAX_BYTES_BILLED: z.coerce.number().int().positive().default(200 * 1024 ** 3),

  // Pipeline cron job mode.
  PIPELINE_MODE: z.enum(["dry-run", "measure", "sample", "monthly"]).default("dry-run"),
  // sample mode: one real domain and a few technology counts, for site copy.
  SAMPLE_ORIGIN: z.string().url().default("https://www.allbirds.com"),
  SAMPLE_TECHNOLOGIES: z.string().default("Shopify,React,HubSpot,Stripe,WordPress,Next.js"),
  // sample mode skips any query whose dry run is bigger than this many GiB.
  SAMPLE_MAX_GIB: z.coerce.number().positive().default(60),
  // Pipeline storage. GCS holds BigQuery's raw Parquet export for a few hours;
  // R2 holds the finished snapshots the query service downloads.
  GCS_BUCKET: z.string().optional(),
  PIPELINE_WORK_DIR: z.string().default("./data/pipeline"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("whichsitesuse-snapshots"),
  // DuckDB memory caps; DuckDB spills to disk beyond them.
  PIPELINE_MEMORY_LIMIT: z.string().default("400MB"),
  SNAPSHOT_MEMORY_LIMIT: z.string().default("256MB"),
  // How often the query service checks R2 for a newer snapshot.
  SNAPSHOT_POLL_MINUTES: z.coerce.number().int().positive().default(360),

  CRAWL_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .optional(),

  // Signs magic links, sessions, CSRF tokens, checkout links and hashes device fingerprints.
  // Required in production; a fixed dev value is used elsewhere.
  SESSION_SECRET: z.string().min(32).optional(),

  // Stripe, WhichSitesUse's own account (test mode until launch).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Transactional email through Loops (magic links, alerts). Without the key, emails are logged instead
  // of sent. Each email is a Loops transactional template; the ids aren't secret (see src/mail/mailer.ts).
  LOOPS_API_KEY: z.string().optional(),
  LOOPS_TEMPLATE_VERIFY: z.string().optional(),
  LOOPS_TEMPLATE_LOGIN: z.string().optional(),
  LOOPS_TEMPLATE_CREDITS_APPROVED: z.string().optional(),
  LOOPS_TEMPLATE_CREDITS_DENIED: z.string().optional(),
  LOOPS_TEMPLATE_ADMIN_ALERT: z.string().optional(),

  // Cloudflare Turnstile on sign-up. Without both keys the check is skipped (local work only).
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // Comma-separated emails that become admins when they verify, and where abuse alerts go.
  ADMIN_EMAILS: z.string().default(""),
  ADMIN_ALERT_EMAIL: z.string().optional(),
  // Alert when more free grants than this go out in one UTC day.
  ALERT_GRANTS_PER_DAY: z.coerce.number().int().positive().default(25),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

const DEV_SECRET = "dev-only-secret-not-for-production-use-000000";

/** The signing secret; refuses to run production without a real one. */
export function sessionSecret(config: Config): string {
  if (config.SESSION_SECRET) return config.SESSION_SECRET;
  if (config.NODE_ENV === "production") throw new Error("SESSION_SECRET must be set in production");
  return DEV_SECRET;
}

export function adminEmails(config: Config): Set<string> {
  return new Set(
    config.ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const ATTRIBUTION =
  "Technology data from HTTP Archive (httparchive.org), detected with its open-source Wappalyzer fork. Core Web Vitals from the Chrome UX Report.";
