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
