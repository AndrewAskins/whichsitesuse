import { describe, expect, it } from "vitest";
import { EXTRACT_SQL, MEASURE_SQL } from "../src/pipeline/sql.js";

// The extract stays in BigQuery's free tier only because it skips the huge
// JSON columns and reads a single monthly partition. These guard that.
describe("extract SQL cost guards", () => {
  it("reads one crawl partition", () => {
    expect(EXTRACT_SQL).toMatch(/WHERE date = @crawl_date/);
  });

  it.each(["lighthouse", "payload", "custom_metrics", "response_body", "summary"])(
    "never reads the %s column",
    (column) => {
      const code = EXTRACT_SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(code).not.toMatch(new RegExp(`\\b${column}\\b`, "i"));
    },
  );

  it("measure wraps the extract", () => {
    expect(MEASURE_SQL).toContain("httparchive.crawl.pages");
    expect(MEASURE_SQL).not.toContain("{{EXTRACT}}");
  });
});

describe("export SQL", () => {
  it("wraps the extract in EXPORT DATA to the given GCS URI", async () => {
    const { EXPORT_SQL } = await import("../src/pipeline/sql.js");
    const sql = EXPORT_SQL("gs://bucket/extract/2026-11-01/*.parquet");
    expect(sql).toContain("uri = 'gs://bucket/extract/2026-11-01/*.parquet'");
    expect(sql).toContain("FROM `httparchive.crawl.pages`");
    expect(sql).not.toContain("{{");
  });
});

describe("SQL aliases", () => {
  // BigQuery rejects reserved keywords as bare aliases (the first measure run failed on "AS rows").
  const RESERVED = ["rows", "range", "groups", "window", "lookup", "hash", "limit", "order", "partition"];
  it.each(["extract.sql", "measure.sql", "sample-stack.sql", "sample-cwv.sql", "sample-counts.sql"])("%s uses no reserved alias", async (file) => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL(`../src/pipeline/sql/${file}`, import.meta.url), "utf8");
    for (const word of RESERVED) expect(sql).not.toMatch(new RegExp(`\\bAS\\s+${word}\\b`, "i"));
  });
});
