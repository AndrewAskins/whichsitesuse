import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("CRAWL_DATE", () => {
  it("pins the monthly run to a crawl month", () => {
    expect(loadConfig({ CRAWL_DATE: "2026-11-01" }).CRAWL_DATE).toBe("2026-11-01");
  });

  it("treats an empty value as unpinned, so it can be cleared without deleting the variable", () => {
    expect(loadConfig({ CRAWL_DATE: "" }).CRAWL_DATE).toBeUndefined();
    expect(loadConfig({ CRAWL_DATE: "  " }).CRAWL_DATE).toBeUndefined();
    expect(loadConfig({}).CRAWL_DATE).toBeUndefined();
  });

  it("still rejects a date that isn't the first of a month", () => {
    expect(() => loadConfig({ CRAWL_DATE: "2026-11-15" })).toThrow("CRAWL_DATE");
  });
});
