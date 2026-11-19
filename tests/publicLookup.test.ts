import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createApp } from "../src/app.js";
import { Snapshot } from "../src/data/snapshot.js";
import { PUBLIC_LIMITS, publicRouter } from "../src/http/public.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot } from "./helpers/fixtureSnapshot.js";

let snapshot: Snapshot;
const servers: Server[] = [];

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  snapshot = await Snapshot.open(await buildFixtureSnapshot(), { serveHttpArchive: true });
});
afterAll(() => {
  for (const s of servers) s.close();
  snapshot.close();
});

describe("free homepage lookup", () => {
  it("answers like lookup_domain, without a key, for nothing", async () => {
    const base = await serve(createApp({ config: testConfig(), getSnapshot: () => snapshot }));
    const res = await fetch(`${base}/v1/public/domains/shop-a.com`);
    expect(res.status).toBe(200);
    const body: any = await res.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.data).toMatchObject({ domain: "shop-a.com", covered: true });
    expect(body.meta).toMatchObject({ credits_used: 0, credits_remaining: null });
    expect(body.meta.attribution).toMatch(/HTTP Archive/);
  });

  it("allows our own sites and nobody else from the browser", async () => {
    const base = await serve(createApp({ config: testConfig(), getSnapshot: () => snapshot }));
    const ours = await fetch(`${base}/v1/public/domains/shop-a.com`, { headers: { Origin: "https://whichsitesuse.com" } });
    expect(ours.headers.get("access-control-allow-origin")).toBe("https://whichsitesuse.com");
    const theirs = await fetch(`${base}/v1/public/domains/shop-a.com`, { headers: { Origin: "https://evil.example" } });
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${base}/v1/public/domains/shop-a.com`, {
      method: "OPTIONS",
      headers: { Origin: "https://www.whichsitesuse.com", "Access-Control-Request-Headers": "x-turnstile-token" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/x-turnstile-token/);
    const health = await fetch(`${base}/health`, { headers: { Origin: "https://whichsitesuse.com" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("https://whichsitesuse.com");
    expect(((await health.json()) as { turnstile_site_key: unknown }).turnstile_site_key).toBeNull();
  });

  it("limits each IP per minute and per day", async () => {
    let t = 0;
    const app = express();
    app.use(publicRouter({ config: testConfig(), getSnapshot: () => snapshot, services: null, now: () => t }));
    const base = await serve(app);
    const call = () => fetch(`${base}/domains/shop-a.com`);
    for (let i = 0; i < PUBLIC_LIMITS.perMinute; i++) expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Spread the rest of the day's allowance over later minutes.
    let used = PUBLIC_LIMITS.perMinute; // the refused call counts toward neither window
    while (used < PUBLIC_LIMITS.perDay) {
      t += 60_000;
      for (let i = 0; i < PUBLIC_LIMITS.perMinute && used < PUBLIC_LIMITS.perDay; i++, used++) await call();
    }
    t += 60_000;
    expect((await call()).status).toBe(429);
  });

  it("says no snapshot yet with a 503", async () => {
    const base = await serve(createApp({ config: testConfig(), getSnapshot: () => null }));
    const res = await fetch(`${base}/v1/public/domains/shop-a.com`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("snapshot_unavailable");
  });

  it("needs a bot-check token once Turnstile is set up", async () => {
    const config = testConfig({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" });
    const base = await serve(createApp({ config, getSnapshot: () => snapshot }));
    const res = await fetch(`${base}/v1/public/domains/shop-a.com`);
    expect(res.status).toBe(401);
    expect(((await (await fetch(`${base}/health`)).json()) as { turnstile_site_key: unknown }).turnstile_site_key).toBe("site");
  });
});
