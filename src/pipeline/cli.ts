import { loadConfig } from "../config.js";
import { log } from "../log.js";
import {
  FREE_TIER_BYTES,
  bigqueryClient,
  costUsd,
  dryRun,
  extractParams,
  latestCrawlDate,
  latestCruxDate,
  newestPartitions,
  run,
} from "./bigquery.js";
import { runMonthly } from "./monthly.js";
import { EXTRACT_SQL, MEASURE_SQL } from "./sql.js";

const GIB = 1024 ** 3;
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * The pipeline cron job. PIPELINE_MODE (or the first argument) picks what it does:
 *   dry-run  report the bytes the extract would scan, for free
 *   measure  run an aggregate-only version of the extract: rows, sites, detections per site, size
 *   monthly  export to GCS, build the Parquet snapshot, publish it to R2
 */
async function main() {
  const config = loadConfig();
  const mode = (process.argv[2] as typeof config.PIPELINE_MODE | undefined) ?? config.PIPELINE_MODE;
  const bq = bigqueryClient(config);
  const cap = config.BIGQUERY_MAX_BYTES_BILLED;

  // What the source tables hold right now, so a wrong month or a stale table shows in the log.
  const partitions: Record<string, unknown> = {};
  for (const [dataset, table] of [
    ["httparchive.crawl", "pages"],
    ["chrome-ux-report.materialized", "device_summary"],
  ] as const) {
    partitions[`${dataset}.${table}`] = await newestPartitions(bq, dataset, table, cap).catch(
      (err: Error) => `unavailable: ${err.message}`,
    );
  }
  log.info({ partitions }, "PIPELINE SOURCE PARTITIONS");

  const crawlDate = config.CRAWL_DATE ?? (await latestCrawlDate(bq, cap));
  const cruxDate = await latestCruxDate(bq, crawlDate, cap);
  const params = extractParams(crawlDate, cruxDate);

  const extract = await dryRun(bq, { query: EXTRACT_SQL, ...params });
  const report = {
    mode,
    project: config.GCP_PROJECT_ID,
    crawl_date: crawlDate,
    crux_date: cruxDate,
    extract_bytes: extract.bytes,
    estimate_accuracy: extract.accuracy,
    tables_read: extract.tables,
    extract_gib: round(extract.bytes / GIB),
    extract_cost_usd_without_free_tier: round(costUsd(extract.bytes), 3),
    share_of_monthly_free_tier: round(extract.bytes / FREE_TIER_BYTES, 3),
    within_free_tier: extract.bytes < FREE_TIER_BYTES,
    max_bytes_billed_cap_gib: round(cap / GIB),
  };
  log.info({ report }, "PIPELINE DRY RUN");
  if (!cruxDate) log.warn({ crawlDate }, "no CrUX month found within four months of the crawl; CWV would be empty");

  if (mode === "dry-run") return;

  if (mode === "measure") {
    if (extract.bytes > cap) throw new Error(`Extract would scan ${report.extract_gib} GiB, over the cap.`);
    const { rows, bytesBilled } = await run<Record<string, unknown>>(bq, { query: MEASURE_SQL, ...params }, cap);
    const m = rows[0] ?? {};
    const rawBytes = Number(m.raw_string_bytes ?? 0);
    log.info(
      {
        measure: {
          ...m,
          bytes_billed: bytesBilled,
          bytes_billed_gib: round(bytesBilled / GIB),
          raw_string_gib: round(rawBytes / GIB),
          // Sorted, dictionary-encoded Parquet typically lands at a quarter or less of raw string bytes.
          estimated_snapshot_gib: round(rawBytes / 4 / GIB),
        },
      },
      "PIPELINE MEASURE",
    );
    return;
  }

  if (extract.bytes > cap) throw new Error(`Extract would scan ${report.extract_gib} GiB, over the cap.`);
  await runMonthly(config, bq, { crawlDate, cruxDate, params });
}

main().catch((err) => {
  log.error({ err }, "pipeline failed");
  process.exit(1);
});
