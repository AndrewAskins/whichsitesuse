import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Snapshot } from "../src/data/snapshot.js";
import { buildFixtureSnapshot } from "./helpers/fixtureSnapshot.js";

let dir: string;
beforeAll(async () => {
  dir = await buildFixtureSnapshot();
});

describe("Snapshot", () => {
  it("reads the manifest and the Parquet tables", async () => {
    const snap = await Snapshot.open(dir, { serveHttpArchive: true });
    expect(snap.manifest.crawl_date).toBe("2026-10-01");
    const [row] = await snap.query<{ n: number }>("SELECT count(*)::INTEGER AS n FROM sites");
    expect(row?.n).toBe(3);
    snap.close();
  });

  it("kill switch hides every HTTP Archive row and keeps live crawl rows", async () => {
    const snap = await Snapshot.open(dir, { serveHttpArchive: false });
    const sites = await snap.query<{ domain: string }>("SELECT domain FROM sites ORDER BY domain");
    expect(sites.map((s) => s.domain)).toEqual(["live-c.io"]);
    const [tech] = await snap.query<{ n: number }>("SELECT count(*)::INTEGER AS n FROM site_tech");
    expect(tech?.n).toBe(1);
    snap.close();
  });
});

afterAll(() => {});
