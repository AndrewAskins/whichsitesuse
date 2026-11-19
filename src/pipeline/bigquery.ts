import { BigQuery, type Query } from "@google-cloud/bigquery";
import type { Config } from "../config.js";
import { LATEST_CRAWL_SQL, LATEST_CRUX_SQL, PARTITIONS_SQL } from "./sql.js";

/** BigQuery's on-demand free tier: the first 1 TiB scanned each month. */
export const FREE_TIER_BYTES = 1024 ** 4;
export const ON_DEMAND_USD_PER_TIB = 6.25;

/**
 * A BigQuery client for the WhichSitesUse Google Cloud project only. Every
 * job carries a maximumBytesBilled cap, so a mistaken query fails instead of
 * running up a bill.
 */
export function bigqueryClient(config: Config): BigQuery {
  if (!config.GCP_PROJECT_ID || !config.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    throw new Error(
      "GCP_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS_JSON must be set (WhichSitesUse project service account).",
    );
  }
  const credentials = JSON.parse(config.GOOGLE_APPLICATION_CREDENTIALS_JSON) as {
    client_email: string;
    private_key: string;
    project_id?: string;
  };
  if (credentials.project_id && credentials.project_id !== config.GCP_PROJECT_ID) {
    throw new Error(
      `The service account belongs to project ${credentials.project_id}, not ${config.GCP_PROJECT_ID}. Refusing to run.`,
    );
  }
  return new BigQuery({
    projectId: config.GCP_PROJECT_ID,
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });
}

export interface DryRunResult {
  bytes: number;
  accuracy: string | null;
  /** Tables BigQuery says the query reads, as project.dataset.table. */
  tables: string[];
}

export async function dryRun(bq: BigQuery, query: Query): Promise<DryRunResult> {
  const [job] = await bq.createQueryJob({ ...query, dryRun: true, location: "US", useQueryCache: false });
  const stats = job.metadata.statistics ?? {};
  const bytes = stats.query?.totalBytesProcessed ?? stats.totalBytesProcessed;
  if (bytes === undefined) {
    throw new Error(`Dry run returned no byte estimate: ${JSON.stringify(stats)}`);
  }
  return {
    bytes: Number(bytes),
    accuracy: stats.query?.totalBytesProcessedAccuracy ?? null,
    tables: (stats.query?.referencedTables ?? []).map(
      (t: { projectId?: string; datasetId?: string; tableId?: string }) => `${t.projectId}.${t.datasetId}.${t.tableId}`,
    ),
  };
}

export interface PartitionInfo {
  partition_id: string;
  total_rows: number;
  total_logical_bytes: number;
  last_modified_time: string | null;
}

/** Newest partitions of a public table, read from metadata (cheap). */
export async function newestPartitions(
  bq: BigQuery,
  dataset: string,
  table: string,
  maxBytesBilled: number,
): Promise<PartitionInfo[]> {
  const { rows } = await run<Record<string, unknown>>(
    bq,
    { query: PARTITIONS_SQL(dataset), params: { table_name: table } },
    maxBytesBilled,
  );
  return rows.map((r) => ({
    partition_id: String(r.partition_id),
    total_rows: Number(r.total_rows),
    total_logical_bytes: Number(r.total_logical_bytes),
    last_modified_time: dateString(r.last_modified_time),
  }));
}

export async function run<T>(bq: BigQuery, query: Query, maxBytesBilled: number): Promise<{ rows: T[]; bytesBilled: number }> {
  const [job] = await bq.createQueryJob({
    ...query,
    location: "US",
    maximumBytesBilled: String(maxBytesBilled),
  });
  const [rows] = await job.getQueryResults();
  const [meta] = await job.getMetadata();
  return { rows: rows as T[], bytesBilled: Number(meta.statistics?.query?.totalBytesBilled ?? 0) };
}

/** Plain date string for a BigQuery DATE value (the client wraps them in objects). */
export function dateString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return String(value);
}

export async function latestCrawlDate(bq: BigQuery, maxBytesBilled: number): Promise<string> {
  const { rows } = await run<{ crawl_date: unknown }>(bq, { query: LATEST_CRAWL_SQL }, maxBytesBilled);
  const date = dateString(rows[0]?.crawl_date);
  if (!date) throw new Error("Couldn't find a complete HTTP Archive crawl partition.");
  return date;
}

export async function latestCruxDate(bq: BigQuery, crawlDate: string, maxBytesBilled: number): Promise<string | null> {
  const { rows } = await run<{ crux_date: unknown }>(
    bq,
    { query: LATEST_CRUX_SQL, params: { crawl_date: crawlDate }, types: { crawl_date: "DATE" } },
    maxBytesBilled,
  );
  return dateString(rows[0]?.crux_date);
}

export function extractParams(crawlDate: string, cruxDate: string | null): Pick<Query, "params" | "types"> {
  return {
    params: { crawl_date: crawlDate, crux_date: cruxDate },
    types: { crawl_date: "DATE", crux_date: "DATE" },
  };
}

export function costUsd(bytes: number): number {
  return (bytes / 1024 ** 4) * ON_DEMAND_USD_PER_TIB;
}
