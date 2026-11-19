import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/abuse/rateLimit.js";
import { createApp } from "../src/app.js";
import { Snapshot } from "../src/data/snapshot.js";
import { listen } from "./helpers/browser.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { buildFixtureSnapshot, QUERY_FIXTURE_ROWS } from "./helpers/fixtureSnapshot.js";

// The data tools through the real gate: what they charge, and what they refuse.
describe.skipIf(!TEST_DATABASE_URL)("data tools and credits", () => {
  let t: TestDb;
  let snapshot: Snapshot;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    t = await createTestDb();
    snapshot = await Snapshot.open(await buildFixtureSnapshot(QUERY_FIXTURE_ROWS), { serveHttpArchive: true });
    const app = createApp({ config: t.config, getSnapshot: () => snapshot, services: t.services, limiter: new RateLimiter() });
    ({ server, base } = await listen(app));
  });
  afterAll(async () => {
    server?.close();
    snapshot?.close();
    await t?.drop();
  });

  const get = async (path: string, key?: string) => {
    const res = await fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("keeps count_sites free and anonymous", async () => {
    const { status, body } = await get("/v1/counts?technologies=shopify,klaviyo");
    expect(status).toBe(200);
    expect(body.data.total).toBeGreaterThan(0);
    expect(body.data.full_list_credits).toBe(body.data.total);
    expect(body.meta.credits_used).toBe(0);
  });

  it("asks anonymous callers of search_sites and lookup_domain to sign up", async () => {
    expect((await get("/v1/sites?technologies=shopify")).status).toBe(401);
    expect((await get("/v1/domains/shop-a.com")).status).toBe(401);
  });

  it("charges 1 credit per site returned and reports the balance", async () => {
    const { secret } = await makeAccount(t.services, "lists@acme.com", { credits: 10, paid: true });
    const { status, body } = await get("/v1/sites?technologies=shopify&technologies=klaviyo&match=any&cwv=lcp:pass", secret);
    expect(status).toBe(200);
    expect(body.data.sites.length).toBeGreaterThan(0);
    expect(body.meta).toMatchObject({ credits_used: body.data.sites.length, credits_remaining: 10 - body.data.sites.length });
  });

  it("exports a CSV page for paid accounts at the same price, and refuses it on the free grant", async () => {
    const { secret } = await makeAccount(t.services, "csv@acme.com", { credits: 10, paid: true });
    const res = await fetch(`${base}/v1/sites?technologies=shopify&format=csv&limit=2`, { headers: { authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("x-credits-used")).toBe("2");
    expect(res.headers.get("x-credits-remaining")).toBe("8");
    expect(res.headers.get("x-attribution")).toMatch(/HTTP Archive/);
    expect(res.headers.get("x-next-cursor")).toBeTruthy();
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toMatch(/^domain,root_url,rank_bucket/);
    expect(lines).toHaveLength(3);

    const trial = await makeAccount(t.services, "trial-csv@acme.com", { credits: 10 });
    const refused = await get("/v1/sites?technologies=shopify&format=csv", trial.secret);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("export_not_allowed");
  });

  it("returns no more sites than the balance covers", async () => {
    const { secret } = await makeAccount(t.services, "small@acme.com", { credits: 1, paid: true });
    const { body } = await get("/v1/sites?technologies=shopify", secret);
    expect(body.data.sites).toHaveLength(1);
    expect(body.meta).toMatchObject({ credits_used: 1, credits_remaining: 0 });
    expect(body.data.next_cursor).not.toBeNull();
  });

  it("answers an empty balance with 402 and checkout links", async () => {
    const { secret } = await makeAccount(t.services, "empty@acme.com", { credits: 0, paid: true });
    const { status, body } = await get("/v1/sites?technologies=shopify", secret);
    expect(status).toBe(402);
    expect(body.error.code).toBe("insufficient_credits");
    expect(body.error.options[0].checkout_url).toBeTruthy();
  });

  it("charges 2 for a covered domain and nothing for one outside the crawl", async () => {
    const { secret } = await makeAccount(t.services, "lookup@acme.com", { credits: 5, paid: true });
    const covered = await get(`/v1/domains/${encodeURIComponent("https://www.shop-a.com/")}`, secret);
    expect(covered.body.data).toMatchObject({ covered: true, domain: "shop-a.com" });
    expect(covered.body.meta).toMatchObject({ credits_used: 2, credits_remaining: 3 });

    const missing = await get("/v1/domains/nowhere.example", secret);
    expect(missing.status).toBe(200);
    expect(missing.body.data.covered).toBe(false);
    expect(missing.body.meta).toMatchObject({ credits_used: 0, credits_remaining: 3 });
  });

  it("refuses a covered lookup when the balance is short", async () => {
    const { secret } = await makeAccount(t.services, "onecredit@acme.com", { credits: 1, paid: true });
    const { status } = await get("/v1/domains/shop-a.com", secret);
    expect(status).toBe(402);
  });

  it("charges the same over MCP", async () => {
    const { secret } = await makeAccount(t.services, "mcp@acme.com", { credits: 10, paid: true });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }),
    );
    const result = await client.callTool({
      name: "search_sites",
      arguments: { technologies: ["shopify"], cwv: { lcp: "pass" }, device: "mobile", max_credits: 5 },
    });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { data: { sites: { domain: string }[] }; meta: { credits_used: number; credits_remaining: number } };
    expect(body.data.sites.map((s) => s.domain)).toEqual(["shop-a.com"]);
    expect(body.meta).toMatchObject({ credits_used: 1, credits_remaining: 9 });
    await client.close();
  });
});
