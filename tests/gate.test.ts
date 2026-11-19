import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { RateLimiter } from "../src/abuse/rateLimit.js";
import { createApp } from "../src/app.js";
import { readCheckoutLink } from "../src/billing/checkoutLinks.js";
import { maxCreditsInput } from "../src/operations/billing.js";
import { operations } from "../src/operations/index.js";
import type { Operation } from "../src/operations/types.js";
import { listen } from "./helpers/browser.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

/** A paid operation that spends `n` credits and reports the budget it was given. */
const input = z.object({ n: z.coerce.number().int().min(0), ...maxCreditsInput });
const spendN: Operation<typeof input.shape, { available: number; maxResults: number | null; canExport: boolean }> = {
  name: "spend_n",
  title: "Spend n",
  description: "Test only.",
  rest: { method: "get", path: "/spend" },
  pricing: "paid",
  input,
  async run({ n }, ctx) {
    ctx.billing.require(n);
    const { available, maxResults, canExport } = ctx.billing;
    return { data: { available, maxResults, canExport }, credits_used: n };
  },
};

describe.skipIf(!TEST_DATABASE_URL)("billing gate", () => {
  let t: TestDb;
  let server: Server;
  let base: string;
  const limiter = new RateLimiter();

  beforeAll(async () => {
    t = await createTestDb();
    const app = createApp({ config: t.config, getSnapshot: () => null, services: t.services, limiter, operations: [...operations, spendN] });
    ({ server, base } = await listen(app));
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });

  const call = (path: string, key?: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers as object) } });

  it("asks anonymous callers of paid tools to sign up", async () => {
    const res = await call("/v1/spend?n=1");
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error.signup_url).toMatch(/\/signup$/);
  });

  it("rejects an unknown or revoked key", async () => {
    expect((await call("/v1/spend?n=1", "wsu_live_nope")).status).toBe(401);
    const { account, key, secret } = await makeAccount(t.services, "revoked@acme.com", { credits: 5 });
    await t.services.accounts.revokeKey(account.id, key.id);
    expect((await call("/v1/spend?n=1", secret)).status).toBe(401);
  });

  it("charges what the operation used and reports the balance left", async () => {
    const { account, secret } = await makeAccount(t.services, "spender@acme.com", { credits: 10, paid: true });
    const res = await call("/v1/spend?n=3", secret);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.meta).toMatchObject({ credits_used: 3, credits_remaining: 7 });
    expect(body.data).toEqual({ available: 10, maxResults: null, canExport: true });
    const usage = await t.db.query("SELECT credits, operation, channel FROM usage_events WHERE account_id = $1", [account.id]);
    expect(usage.rows).toEqual([{ credits: 3, operation: "spend_n", channel: "rest" }]);
  });

  it("returns 402 with checkout links when the balance is short", async () => {
    const { account, secret } = await makeAccount(t.services, "short@acme.com", { credits: 2 });
    const res = await call("/v1/spend?n=1500", secret);
    expect(res.status).toBe(402);
    const body: any = await res.json();
    expect(body.error).toMatchObject({ code: "insufficient_credits", credits_needed: 1500, credits_available: 2, reason: "balance" });
    const [topup, plan] = body.error.options;
    expect(topup).toMatchObject({ item: "topup", units: 2, price: "$30" });
    expect(plan.item).toBe("starter");
    const token = new URL(topup.checkout_url).pathname.split("/").pop()!;
    expect(readCheckoutLink(t.config, token)).toMatchObject({ a: account.id, i: "topup", u: 2 });
    expect((await t.services.ledger.balance(account.id)).total).toBe(2);
  });

  it("names max_credits and the key cap when they are the limit", async () => {
    const { account, key, secret } = await makeAccount(t.services, "capped@acme.com", { credits: 100 });
    const tooMuch: any = await (await call("/v1/spend?n=5&max_credits=4", secret)).json();
    expect(tooMuch.error.reason).toBe("max_credits");

    await t.services.accounts.setKeyCap(account.id, key.id, 5);
    expect((await call("/v1/spend?n=4", secret)).status).toBe(200);
    const capped: any = await (await call("/v1/spend?n=2", secret)).json();
    expect(capped.error).toMatchObject({ reason: "key_cap", credits_available: 1 });
  });

  it("puts accounts that never paid on the trial caps", async () => {
    const { secret } = await makeAccount(t.services, "trial@acme.com", { credits: 250, bucket: "trial" });
    const body: any = await (await call("/v1/spend?n=0", secret)).json();
    expect(body.data).toEqual({ available: 250, maxResults: 100, canExport: false });
  });

  it("refuses suspended accounts", async () => {
    const { account, secret } = await makeAccount(t.services, "bad@acme.com", { credits: 5 });
    await t.services.accounts.setSuspended(account.id, true, "farming");
    expect((await call("/v1/spend?n=1", secret)).status).toBe(403);
  });

  it("rate-limits trial accounts at 30 calls a minute", async () => {
    const { secret } = await makeAccount(t.services, "fast@acme.com", { credits: 250, bucket: "trial" });
    for (let i = 0; i < 30; i++) expect((await call("/v1/spend?n=0", secret)).status).toBe(200);
    const res = await call("/v1/spend?n=0", secret);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("serves get_balance and buy_credits over REST", async () => {
    const { account, secret } = await makeAccount(t.services, "buyer@acme.com", { credits: 250, bucket: "trial" });
    const bal: any = await (await call("/v1/balance", secret)).json();
    expect(bal.data.credits).toEqual({ total: 250, plan: 0, topup: 0, free: 250 });
    expect(bal.data.trial.max_results_per_call).toBe(100);
    expect(bal.meta.credits_remaining).toBe(250);
    expect((await call("/v1/balance")).status).toBe(401);

    const res = await call("/v1/checkout", secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: "topup", units: 3 }),
    });
    const buy: any = await res.json();
    expect(buy.data).toMatchObject({ item: "topup", credits: 3000, price: "$45" });
    const token = new URL(buy.data.checkout_url).pathname.split("/").pop()!;
    expect(readCheckoutLink(t.config, token)).toMatchObject({ a: account.id, i: "topup", u: 3 });
  });

  it("authenticates MCP calls with the same key", async () => {
    const { secret } = await makeAccount(t.services, "mcp@acme.com", { credits: 9, paid: true });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }),
    );
    const spent = await client.callTool({ name: "spend_n", arguments: { n: 4 } });
    expect((spent.structuredContent as any).meta).toMatchObject({ credits_used: 4, credits_remaining: 5 });
    const bal = await client.callTool({ name: "get_balance", arguments: {} });
    expect((bal.structuredContent as any).data.credits.total).toBe(5);
    await client.close();

    const anon = new Client({ name: "test", version: "0.0.0" });
    await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const denied = await anon.callTool({ name: "spend_n", arguments: { n: 1 } });
    expect(denied.isError).toBe(true);
    await anon.close();
  });
});
