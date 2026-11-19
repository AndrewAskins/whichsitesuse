import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { findTechnologies, normalizeKey } from "../src/operations/findTechnologies.js";
import { OperationError, type OperationContext } from "../src/operations/types.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot } from "./helpers/fixtureSnapshot.js";

let ctx: OperationContext;
beforeAll(async () => {
  const snapshot = await Snapshot.open(await buildFixtureSnapshot(), { serveHttpArchive: true });
  ctx = { config: testConfig(), snapshot };
});
afterAll(() => ctx.snapshot?.close());

const find = (q: string, limit = 10) => findTechnologies.run(findTechnologies.input.parse({ q, limit }), ctx);

describe("normalizeKey", () => {
  it("keeps letters and digits only", () => {
    expect(normalizeKey("Word Press")).toBe("wordpress");
    expect(normalizeKey("Next.js")).toBe("nextjs");
  });
});

describe("find_technologies", () => {
  it("puts the exact name first, then prefix matches", async () => {
    const { data, credits_used } = await find("shopify");
    expect(data.matches.map((m) => m.name)).toEqual(["Shopify", "Shopify Pay"]);
    expect(credits_used).toBe(0);
  });

  it("matches aliases exactly", async () => {
    const { data } = await find("shopify plus");
    expect(data.matches[0]?.name).toBe("Shopify");
  });

  it("ignores spacing and punctuation", async () => {
    const { data } = await find("Word Press");
    expect(data.matches[0]?.slug).toBe("wordpress");
  });

  it("finds technologies by category and returns disambiguation notes", async () => {
    const { data } = await find("email marketing");
    expect(data.matches.map((m) => m.name).sort()).toEqual(["Doppler", "Klaviyo"]);
    expect(data.matches.find((m) => m.name === "Doppler")?.note).toMatch(/fromdoppler\.com/);
  });

  it("respects the limit", async () => {
    const { data } = await find("shopify", 1);
    expect(data.matches).toHaveLength(1);
  });

  it("answers snapshot_unavailable before a snapshot exists", async () => {
    await expect(
      findTechnologies.run(findTechnologies.input.parse({ q: "x" }), { ...ctx, snapshot: null }),
    ).rejects.toBeInstanceOf(OperationError);
  });
});
