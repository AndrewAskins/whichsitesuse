import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { countSites } from "../src/operations/countSites.js";
import { OperationError, type OperationContext } from "../src/operations/types.js";
import { testConfig } from "./helpers/config.js";
import { anonymousContext, fixedBilling } from "./helpers/context.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

let ctx: OperationContext;
let killed: OperationContext;
beforeAll(async () => {
  const dir = await buildFixtureSnapshot(QUERY_FIXTURE_ROWS);
  ctx = { ...anonymousContext(testConfig(), await Snapshot.open(dir, { serveHttpArchive: true })), billing: fixedBilling(1_000_000) };
  killed = { ...anonymousContext(testConfig(), await Snapshot.open(dir, { serveHttpArchive: false })), billing: fixedBilling(1_000_000) };
});
afterAll(() => {
  ctx.snapshot?.close();
  killed.snapshot?.close();
});

const count = (raw: Record<string, unknown>, c = ctx) => countSites.run(countSites.input.parse(raw), c);
const total = async (raw: Record<string, unknown>) => (await count(raw)).data.total;

describe("count_sites", () => {
  it("counts a technology, by rank bucket, for free", async () => {
    const { data, credits_used } = await count({ technologies: ["shopify"] });
    expect(credits_used).toBe(0);
    expect(data.total).toBe(5);
    expect(data.full_list_credits).toBe(5);
    expect(data.by_rank_bucket).toEqual([
      { rank_bucket: 1000, sites: 1 },
      { rank_bucket: 10000, sites: 2 },
      { rank_bucket: 100000, sites: 1 },
      { rank_bucket: 1000000, sites: 0 },
      { rank_bucket: 10000000, sites: 0 },
      { rank_bucket: 100000000, sites: 0 },
      { rank_bucket: null, sites: 1 },
    ]);
  });

  it("matches all listed technologies by default, or any of them", async () => {
    expect(await total({ technologies: ["shopify", "klaviyo"] })).toBe(2);
    expect(await total({ technologies: ["shopify", "klaviyo"], match: "any" })).toBe(6);
  });

  it("accepts REST-style comma lists and repeated params", async () => {
    expect(await total({ technologies: "shopify,klaviyo" })).toBe(2);
    expect(await total({ technologies: ["shopify", "klaviyo, wordpress"], match: "any" })).toBe(8);
  });

  it("drops sites using an excluded technology", async () => {
    expect(await total({ technologies: ["shopify"], exclude_technologies: ["klaviyo"] })).toBe(3);
  });

  it("filters by category, case-insensitively, alone or with technologies", async () => {
    expect(await total({ category: "EMAIL marketing" })).toBe(4);
    expect(await total({ technologies: ["shopify"], category: "Email marketing" })).toBe(3);
  });

  it("filters the matched technologies by version prefix", async () => {
    expect(await total({ technologies: ["wordpress"], version: "6" })).toBe(2);
    expect(await total({ technologies: ["wordpress"], version: "6.8" })).toBe(1);
    expect(await total({ technologies: ["wordpress"], version: "6.8.10" })).toBe(0);
  });

  it("filters by rank, including unknown rank", async () => {
    expect(await total({ technologies: ["shopify"], max_rank: 10000 })).toBe(3);
    expect(await total({ technologies: ["shopify"], rank_buckets: ["unknown"] })).toBe(1);
    expect(await total({ technologies: ["shopify"], rank_buckets: "1000,unknown" })).toBe(2);
  });

  it("filters by TLD", async () => {
    expect(await total({ technologies: ["shopify"], tld: ["co.uk"] })).toBe(1);
    expect(await total({ technologies: ["shopify"], tld: "com" })).toBe(3);
  });

  it("filters by Core Web Vitals on the chosen device", async () => {
    // Mobile p75s by default; sites without field data match neither pass nor fail.
    expect(await total({ technologies: ["shopify"], cwv: { lcp: "pass" } })).toBe(1);
    expect(await total({ technologies: ["shopify"], cwv: "lcp:fail" })).toBe(2);
    expect(await total({ technologies: ["shopify"], cwv: { lcp: "pass" }, device: "desktop" })).toBe(3);
    expect(await total({ technologies: ["shopify"], cwv: { lcp: "fail" }, device: "desktop" })).toBe(1);
  });

  it("requires the technology on the chosen device", async () => {
    expect(await total({ technologies: ["shopify"], device: "mobile" })).toBe(4);
    expect(await total({ technologies: ["shopify"], device: "desktop" })).toBe(5);
  });

  it("names unknown slugs and points to find_technologies", async () => {
    const err = await count({ technologies: ["shopify", "nope"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe("invalid_input");
    expect((err as OperationError).message).toMatch(/nope.*find_technologies/);
    expect((err as OperationError).details.unknown_technologies).toEqual(["nope"]);
  });

  it("requires technologies or a category", async () => {
    const err = await count({}).catch((e: unknown) => e);
    expect((err as OperationError).code).toBe("invalid_input");
    expect((err as OperationError).message).toMatch(/technologies.*category/);
  });

  it("rejects a category with no technologies", async () => {
    const err = await count({ category: "Nonsense" }).catch((e: unknown) => e);
    expect((err as OperationError).code).toBe("invalid_input");
  });

  it("hides HTTP Archive rows when the kill switch is off", async () => {
    const { data } = await count({ technologies: ["shopify"] }, killed);
    expect(data.total).toBe(1);
    expect(data.by_rank_bucket.at(-1)).toEqual({ rank_bucket: null, sites: 1 });
  });
});
