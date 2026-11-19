import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BigQuery } from "@google-cloud/bigquery";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("../src/pipeline/gcs.js", () => ({
  gcsClient: () => ({}),
  exportPrefix: (d: string) => `extract/${d}/`,
  deletePrefix: vi.fn(async (_s: unknown, _b: string, prefix: string) => void calls.push(`delete ${prefix}`)),
  downloadPrefix: vi.fn(async () => (calls.push("download"), [])),
}));
vi.mock("../src/pipeline/bigquery.js", () => ({
  run: vi.fn(async () => (calls.push("export"), { bytesBilled: 0 })),
}));
vi.mock("../src/storage/r2.js", () => ({
  r2Client: () => ({}),
  readCurrent: vi.fn(async () => null),
  downloadSnapshot: vi.fn(),
  uploadSnapshot: vi.fn(async () => (calls.push("upload"), { crawl_date: "2026-11-01", prefix: "snapshots/2026-11-01/" })),
}));
vi.mock("../src/pipeline/transform.js", () => ({
  buildSnapshot: vi.fn(async () => (calls.push("build"), { counts: {} })),
}));
vi.mock("../src/pipeline/overrides.js", () => ({ loadTechnologyOverrides: vi.fn(async () => []) }));
vi.mock("../src/seo/publish.js", () => ({ publishSeoDataset: vi.fn(async () => undefined) }));

const { runMonthly } = await import("../src/pipeline/monthly.js");
const { loadConfig } = await import("../src/config.js");

describe("runMonthly", () => {
  beforeEach(() => void (calls.length = 0));

  it("clears the export prefix before exporting, so a failed run's files are never read", async () => {
    const config = loadConfig({
      GCS_BUCKET: "extracts",
      PIPELINE_WORK_DIR: join(mkdtempSync(join(tmpdir(), "wsu-monthly-")), "work"),
    });
    await runMonthly(config, {} as BigQuery, { crawlDate: "2026-11-01", cruxDate: null, params: {} });
    expect(calls).toEqual([
      "delete extract/2026-11-01/",
      "export",
      "download",
      "build",
      "upload",
      "delete extract/2026-11-01/",
    ]);
  });
});
