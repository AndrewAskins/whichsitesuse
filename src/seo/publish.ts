import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { Snapshot } from "../data/snapshot.js";
import { log } from "../log.js";
import { downloadSnapshot, r2Client, readCurrent } from "../storage/r2.js";
import { buildSeoDataset } from "./dataset.js";
import { downloadSeoDataset, readSeoPointer, uploadSeoDataset } from "./storage.js";

/** Builds the SEO dataset from a snapshot on disk and publishes it, with last month's counts for change. */
export async function publishSeoDataset(config: Config, s3: S3Client, snapshotDir: string): Promise<void> {
  const snapshot = await Snapshot.open(snapshotDir, { serveHttpArchive: config.SERVE_HTTPARCHIVE, memoryLimit: config.PIPELINE_MEMORY_LIMIT });
  try {
    const pointer = await readSeoPointer(s3, config.R2_BUCKET);
    const previous =
      pointer && pointer.crawl_date < snapshot.manifest.crawl_date ? await downloadSeoDataset(s3, config.R2_BUCKET, pointer.key) : null;
    const started = Date.now();
    const data = await buildSeoDataset(snapshot, { previous });
    const published = await uploadSeoDataset(s3, config.R2_BUCKET, data);
    log.info(
      {
        pointer: published,
        technologies: data.technologies.length,
        categories: data.categories.length,
        previous: previous?.crawl_date ?? null,
        seconds: Math.round((Date.now() - started) / 1000),
      },
      "PIPELINE SEO DATASET PUBLISHED",
    );
  } finally {
    snapshot.close();
  }
}

/** PIPELINE_MODE=seo: rebuild the pages' data from the snapshot already on R2, with no BigQuery. */
export async function runSeoOnly(config: Config): Promise<void> {
  const s3 = r2Client(config);
  const current = await readCurrent(s3, config.R2_BUCKET);
  if (!current) throw new Error("No snapshot on R2 yet: run the monthly pipeline first.");
  const dir = join(config.PIPELINE_WORK_DIR, "seo-snapshot");
  await downloadSnapshot(s3, config.R2_BUCKET, current, dir);
  try {
    await publishSeoDataset(config, s3, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
