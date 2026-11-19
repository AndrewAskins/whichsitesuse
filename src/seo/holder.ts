import type { Config } from "../config.js";
import { log } from "../log.js";
import { r2Client, r2Configured } from "../storage/r2.js";
import type { SeoDataset } from "./dataset.js";
import { PagePlan } from "./pages.js";
import { downloadSeoDataset, readSeoDatasetFile, readSeoPointer } from "./storage.js";

/**
 * Keeps the newest SEO dataset in memory as a PagePlan. Reads SEO_DATASET_PATH when set
 * (local work and the static preview), otherwise polls seo/current.json on R2 on the
 * same schedule as the snapshot.
 */
export class SeoHolder {
  private plan: PagePlan | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {}

  get(): PagePlan | null {
    return this.plan;
  }

  set(data: SeoDataset): void {
    this.plan = new PagePlan(data);
    log.info({ crawl_date: data.crawl_date, technologies: this.plan.tech.size, indexed: this.plan.indexedTech.size }, "seo dataset loaded");
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.config.SEO_DATASET_PATH && r2Configured(this.config)) {
      this.timer = setInterval(() => {
        this.refresh().catch((err) => log.error({ err }, "seo dataset refresh failed"));
      }, this.config.SNAPSHOT_POLL_MINUTES * 60_000);
      this.timer.unref();
    }
  }

  async refresh(): Promise<void> {
    if (this.config.SEO_DATASET_PATH) {
      if (!this.plan) this.set(await readSeoDatasetFile(this.config.SEO_DATASET_PATH));
      return;
    }
    if (!r2Configured(this.config)) return;
    const s3 = r2Client(this.config);
    const pointer = await readSeoPointer(s3, this.config.R2_BUCKET);
    if (!pointer) {
      log.warn("no seo dataset published to R2 yet; technology pages answer 404");
      return;
    }
    if (this.plan?.data.crawl_date === pointer.crawl_date) return;
    const data = await downloadSeoDataset(s3, this.config.R2_BUCKET, pointer.key);
    if (data) this.set(data);
  }
}
