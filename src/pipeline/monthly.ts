import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BigQuery, Query } from "@google-cloud/bigquery";
import type { Config } from "../config.js";
import { SNAPSHOT_FILES } from "../data/schema.js";
import { log } from "../log.js";
import { publishSeoDataset } from "../seo/publish.js";
import { downloadSnapshot, r2Client, readCurrent, uploadSnapshot } from "../storage/r2.js";
import { run } from "./bigquery.js";
import { deletePrefix, downloadPrefix, exportPrefix, gcsClient } from "./gcs.js";
import { loadTechnologyOverrides } from "./overrides.js";
import { EXPORT_SQL } from "./sql.js";
import { buildSnapshot } from "./transform.js";

/**
 * The monthly run: BigQuery export to GCS, download, build the snapshot with
 * DuckDB, upload to R2, then point current.json at it. Skips a month that is
 * already current unless CRAWL_DATE pins it.
 */
export async function runMonthly(
  config: Config,
  bq: BigQuery,
  dates: { crawlDate: string; cruxDate: string | null; params: Pick<Query, "params" | "types"> },
): Promise<void> {
  if (!config.GCS_BUCKET) throw new Error("GCS_BUCKET must be set for the monthly run.");
  const s3 = r2Client(config);
  const current = await readCurrent(s3, config.R2_BUCKET);
  if (current?.crawl_date === dates.crawlDate && !config.CRAWL_DATE) {
    log.info({ crawl_date: dates.crawlDate }, "snapshot already current; nothing to do");
    return;
  }

  const work = config.PIPELINE_WORK_DIR;
  await rm(work, { recursive: true, force: true });
  const rawDir = join(work, "raw");
  const outDir = join(work, "snapshot");
  const prevDir = join(work, "previous");

  const storage = gcsClient(config);
  const prefix = exportPrefix(dates.crawlDate);
  const uri = `gs://${config.GCS_BUCKET}/${prefix}*.parquet`;
  // A failed run leaves its export behind, and EXPORT DATA's overwrite only replaces
  // files with the same names. Clear the prefix first so the download can't mix two
  // exports (November's first build counted about half its rows twice).
  await deletePrefix(storage, config.GCS_BUCKET, prefix);
  const exported = await run(bq, { query: EXPORT_SQL(uri), ...dates.params }, config.BIGQUERY_MAX_BYTES_BILLED);
  log.info({ uri, bytes_billed: exported.bytesBilled }, "extract exported");

  const files = await downloadPrefix(storage, config.GCS_BUCKET, prefix, rawDir);
  log.info({ files: files.length }, "extract downloaded");

  if (current) {
    await downloadSnapshot(s3, config.R2_BUCKET, current, prevDir);
    log.info({ previous: current.crawl_date }, "previous snapshot downloaded for first_seen");
  }

  const manifest = await buildSnapshot({
    rawGlob: join(rawDir, "*.parquet"),
    outDir,
    crawlDate: dates.crawlDate,
    cruxDate: dates.cruxDate,
    overrides: await loadTechnologyOverrides(config.DATABASE_URL),
    previousDir: existsSync(join(prevDir, SNAPSHOT_FILES.manifest)) ? prevDir : null,
    memoryLimit: config.PIPELINE_MEMORY_LIMIT,
    threads: config.PIPELINE_THREADS,
    tempDir: join(work, "duckdb-tmp"),
    // The raw extract is several GB; drop it as soon as the working tables hold it.
    onRawConsumed: () => rm(rawDir, { recursive: true, force: true }),
  });
  log.info({ manifest }, "snapshot built");

  const pointer = await uploadSnapshot(s3, config.R2_BUCKET, outDir, manifest);
  log.info({ pointer }, "PIPELINE SNAPSHOT PUBLISHED");

  // The programmatic pages' data. A failure here leaves last month's pages up; rerun with PIPELINE_MODE=seo.
  await publishSeoDataset(config, s3, outDir).catch((err) => log.error({ err }, "seo dataset failed; rerun with PIPELINE_MODE=seo"));

  await deletePrefix(storage, config.GCS_BUCKET, prefix);
  await rm(work, { recursive: true, force: true });
}
