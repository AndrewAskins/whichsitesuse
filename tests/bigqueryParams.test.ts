import { BigQuery, type Query } from "@google-cloud/bigquery";
import { describe, expect, it } from "vitest";
import { extractParams } from "../src/pipeline/bigquery.js";

/** Captures the query parameters the client would send, without a network call. */
async function encoded(query: Query) {
  const bq = new BigQuery({ projectId: "test" });
  let sent: unknown;
  (bq as unknown as { request: (o: { json: { configuration: { query: { queryParameters: unknown } } } }) => never }).request = (o) => {
    sent = o.json.configuration.query.queryParameters;
    throw new Error("stop");
  };
  await bq.createQueryJob({ ...query, query: "SELECT 1", dryRun: true }).catch(() => {});
  return sent as { name: string; parameterValue: { value?: unknown } }[];
}

describe("extract parameters", () => {
  it("send the crawl and CrUX dates as real DATE values", async () => {
    const params = await encoded(extractParams("2026-10-01", "2026-09-01"));
    expect(params.find((p) => p.name === "crawl_date")?.parameterValue.value).toBe("2026-10-01");
    expect(params.find((p) => p.name === "crux_date")?.parameterValue.value).toBe("2026-09-01");
  });

  it("send a typed NULL when there is no CrUX month", async () => {
    const params = await encoded(extractParams("2026-10-01", null));
    expect(params.find((p) => p.name === "crux_date")?.parameterValue.value).toBeNull();
  });
});
