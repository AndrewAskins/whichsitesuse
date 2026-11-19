import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { downloadSnapshot, r2Client, r2Configured, readCurrent } from "../storage/r2.js";
import { SNAPSHOT_FILES, type SnapshotManifest } from "./schema.js";
import { Snapshot } from "./snapshot.js";

/**
 * Keeps the query service on the newest snapshot: downloads it from R2 when
 * current.json points at a month that isn't on disk, then swaps the open
 * DuckDB snapshot. Without R2 it just opens whatever is on disk.
 */
export class SnapshotHolder {
  private snapshot: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {}

  get(): Snapshot | null {
    return this.snapshot;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (r2Configured(this.config)) {
      this.timer = setInterval(() => {
        this.refresh().catch((err) => log.error({ err }, "snapshot refresh failed"));
      }, this.config.SNAPSHOT_POLL_MINUTES * 60_000);
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    const root = this.config.SNAPSHOT_DIR;
    if (!r2Configured(this.config)) {
      // Local development: open whatever snapshot sits in SNAPSHOT_DIR.
      if (!this.snapshot && existsSync(join(root, SNAPSHOT_FILES.manifest))) await this.open(root);
      if (!this.snapshot) log.warn({ dir: root }, "no snapshot on disk yet; data tools will answer snapshot_unavailable");
      return;
    }
    const s3 = r2Client(this.config);
    const pointer = await readCurrent(s3, this.config.R2_BUCKET);
    if (!pointer) {
      log.warn("no snapshot published to R2 yet; data tools will answer snapshot_unavailable");
      return;
    }
    if (this.snapshot?.manifest.crawl_date === pointer.crawl_date) return;
    // Each month gets its own directory, so the open snapshot keeps reading its files during the download.
    const dir = join(root, pointer.crawl_date);
    if ((await localManifest(dir))?.crawl_date !== pointer.crawl_date) {
      log.info({ crawl_date: pointer.crawl_date }, "downloading snapshot from R2");
      await downloadSnapshot(s3, this.config.R2_BUCKET, pointer, dir);
    }
    const previousDir = this.snapshotDir;
    await this.open(dir);
    if (previousDir && previousDir !== dir) {
      // Let in-flight queries on the old month finish before deleting its files.
      setTimeout(() => void rm(previousDir, { recursive: true, force: true }), 120_000).unref();
    }
  }

  private snapshotDir: string | null = null;

  private async open(dir: string) {
    const next = await Snapshot.open(dir, {
      serveHttpArchive: this.config.SERVE_HTTPARCHIVE,
      memoryLimit: this.config.SNAPSHOT_MEMORY_LIMIT,
    });
    const old = this.snapshot;
    this.snapshot = next;
    this.snapshotDir = dir;
    if (old) setTimeout(() => old.close(), 60_000).unref();
    log.info({ manifest: next.manifest, serveHttpArchive: this.config.SERVE_HTTPARCHIVE }, "snapshot loaded");
  }
}

async function localManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, SNAPSHOT_FILES.manifest), "utf8")) as SnapshotManifest;
  } catch {
    return null;
  }
}
