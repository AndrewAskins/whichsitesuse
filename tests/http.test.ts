import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Snapshot } from "../src/data/snapshot.js";
import { operations } from "../src/operations/index.js";
import { testConfig } from "./helpers/config.js";
import { buildFixtureSnapshot } from "./helpers/fixtureSnapshot.js";

let server: Server;
let base: string;
let snapshot: Snapshot | null;

beforeAll(async () => {
  snapshot = await Snapshot.open(await buildFixtureSnapshot(), { serveHttpArchive: true });
  const app = createApp({ config: testConfig(), getSnapshot: () => snapshot });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  snapshot?.close();
});

describe("REST", () => {
  it("reports health and the loaded crawl", async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body).toMatchObject({ ok: true, snapshot: { crawl_date: "2026-10-01" }, serving_httparchive: true });
  });

  it("serves find_technologies with the shared envelope", async () => {
    const res = await fetch(`${base}/v1/technologies?q=shopify&limit=1`);
    expect(res.status).toBe(200);
    const body: any = await res.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.data.matches[0].slug).toBe("shopify");
    expect(body.meta).toMatchObject({ crawl_date: "2026-10-01", credits_used: 0 });
    expect(body.meta.attribution).toMatch(/HTTP Archive/);
  });

  it("rejects invalid input with field-level issues", async () => {
    const res = await fetch(`${base}/v1/technologies?q=`);
    expect(res.status).toBe(400);
    const body: any = await res.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.issues[0].field).toBe("q");
  });

  it("serves the site tools with comma lists, repeated params and the shared envelope", async () => {
    const count: any = await (await fetch(`${base}/v1/counts?technologies=shopify,klaviyo`)).json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(count.data).toMatchObject({ total: 1, full_list_credits: 1 });
    expect(count.meta.credits_used).toBe(0);

    const res = await fetch(`${base}/v1/sites?technologies=shopify&technologies=klaviyo&match=any&limit=1&cwv=lcp:pass`);
    expect(res.status).toBe(200);
    const sites: any = await res.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(sites.data.sites.map((s: { domain: string }) => s.domain)).toEqual(["shop-a.com"]);
    expect(sites.data.next_cursor).toBeNull();
    expect(sites.meta).toMatchObject({ crawl_date: "2026-10-01", credits_used: 1 });

    const domain: any = await (await fetch(`${base}/v1/domains/${encodeURIComponent("https://www.shop-a.com/")}`)).json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(domain.data).toMatchObject({ covered: true, domain: "shop-a.com" });
    expect(domain.meta.credits_used).toBe(2);

    const missing = await fetch(`${base}/v1/domains/nowhere.example`);
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as any).meta.credits_used).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any

    const unknown = await fetch(`${base}/v1/counts?technologies=nope`);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).error.unknown_technologies).toEqual(["nope"]); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("returns 503 while no snapshot is loaded", async () => {
    const saved = snapshot;
    snapshot = null;
    const res = await fetch(`${base}/v1/technologies?q=shopify`);
    snapshot = saved;
    expect(res.status).toBe(503);
  });
});

describe("MCP over Streamable HTTP", () => {
  it("lists every operation as a tool and calls one", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(operations.map((o) => o.name));

    const result = await client.callTool({ name: "find_technologies", arguments: { q: "wordpress" } });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { data: { matches: { slug: string }[] } };
    expect(body.data.matches[0]?.slug).toBe("wordpress");
    await client.close();
  });

  it("calls search_sites with real arrays and objects", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const result = await client.callTool({
      name: "search_sites",
      arguments: { technologies: ["shopify"], cwv: { lcp: "pass" }, device: "mobile", max_credits: 5 },
    });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as { data: { sites: { domain: string }[] }; meta: { credits_used: number } };
    expect(body.data.sites.map((s) => s.domain)).toEqual(["shop-a.com"]);
    expect(body.meta.credits_used).toBe(1);

    const lookup = await client.callTool({ name: "lookup_domain", arguments: { domain: "live-c.io" } });
    expect((lookup.structuredContent as { data: { covered: boolean } }).data.covered).toBe(true);
    await client.close();
  });

  it("returns tool errors as isError results, not protocol errors", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const result = await client.callTool({ name: "find_technologies", arguments: { q: "x".repeat(200) } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
