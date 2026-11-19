import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTechnologyOverrides } from "../src/pipeline/overrides.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

describe.skipIf(!TEST_DATABASE_URL)("seeded technology cleanup", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds search aliases and the Doppler note, and merges or hides nothing", async () => {
    const rows = await loadTechnologyOverrides(t.config.DATABASE_URL);
    const by = new Map(rows.map((r) => [r.source_name, r]));
    expect(by.get("Google Tag Manager")?.aliases).toContain("GTM");
    expect(by.get("Doppler")).toMatchObject({ vendor_domain: "fromdoppler.com", note: expect.stringMatching(/not the Doppler secrets manager/) });
    expect(rows.every((r) => r.merge_into === null && !r.hidden && r.display_name === null && r.categories === null)).toBe(true);
  });
});
