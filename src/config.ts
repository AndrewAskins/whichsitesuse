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
  PIPELINE_MODE: z.enum(["dry-run", "measure", "monthly"]).default("dry-run"),
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

export const ATTRIBUTION =
  "Technology data from HTTP Archive (httparchive.org), detected with its open-source Wappalyzer fork. Core Web Vitals from the Chrome UX Report.";
