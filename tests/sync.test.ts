import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../src/data/sync.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot } from "./helpers/fixtureSnapshot.js";

describe("SnapshotHolder without R2", () => {
  it("opens the snapshot in SNAPSHOT_DIR", async () => {
    const dir = await buildFixtureSnapshot();
    const holder = new SnapshotHolder(testConfig({ SNAPSHOT_DIR: dir }));
    await holder.start();
    expect(holder.get()?.manifest.crawl_date).toBe("2026-10-01");
    holder.get()?.close();
  });

  it("stays empty when there is no snapshot", async () => {
    const holder = new SnapshotHolder(testConfig({ SNAPSHOT_DIR: "/nonexistent/wsu" }));
    await holder.start();
    expect(holder.get()).toBeNull();
  });
});
