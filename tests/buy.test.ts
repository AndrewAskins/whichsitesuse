import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hmac, randomToken, sha256, signPayload } from "../src/auth/tokens.js";
import { checkoutLink } from "../src/billing/checkoutLinks.js";
import { sessionSecret } from "../src/config.js";
import type { Services } from "../src/services.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { fakeStripe } from "./helpers/fakeStripe.js";

describe.skipIf(!TEST_DATABASE_URL)("checkout pages", () => {
  let t: TestDb;
  const fake = fakeStripe();
  const servers: Server[] = [];

  async function serve(services: Services): Promise<string> {
    const server = createApp({ config: services.config, getSnapshot: () => null, services }).listen(0);
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  let base: string;

  beforeAll(async () => {
    t = await createTestDb({ stripe: fake.stripe });
    base = await serve(t.services);
  });
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await t?.drop();
  });

  const get = (url: string, cookie?: string) => fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
  /** The path of a /buy link, served by this test's app rather than PUBLIC_BASE_URL. */
  const buyPath = (link: string) => new URL(link).pathname;

  async function signIn(accountId: string) {
    const token = randomToken(32);
    const { rows } = await t.db.query<{ id: string }>(
      `INSERT INTO web_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [accountId, sha256(token)],
    );
    return { cookie: `wsu_session=${token}`, csrf: hmac(sessionSecret(t.config), `csrf:${rows[0]!.id}`) };
  }

  it("redirects a valid /buy link to Stripe Checkout without a sign-in", async () => {
    const { account } = await makeAccount(t.services, "buyer@acme.test");
    const res = await get(base + buyPath(checkoutLink(t.config, account.id, "topup", 2)));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(fake.calls.checkoutCreate.at(-1)).toMatchObject({ mode: "payment", client_reference_id: account.id, line_items: [{ quantity: 2 }] });
  });

  it("shows an expired page for an expired, forged or orphaned link", async () => {
    const { account } = await makeAccount(t.services, "late@acme.test");
    const expired = signPayload(sessionSecret(t.config), { a: account.id, i: "topup", u: 1, exp: Math.floor(Date.now() / 1000) - 60 });
    const orphan = buyPath(checkoutLink(t.config, randomUUID(), "starter"));
    for (const path of [`/buy/${expired}`, "/buy/not-a-token", orphan]) {
      const res = await get(base + path);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("expired");
      expect(body).toContain("sign in");
    }
  });

  it("answers 503 when Stripe isn't configured", async () => {
    const { account } = await makeAccount(t.services, "nobilling@acme.test");
    const noStripe = await serve({ ...t.services, stripe: null });
    const res = await get(noStripe + buyPath(checkoutLink(t.config, account.id, "topup")));
    expect(res.status).toBe(503);
  });

  it("won't open the billing portal from a plan link for a subscribed account", async () => {
    const { account } = await makeAccount(t.services, "subbed@acme.test");
    await t.db.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x', plan = 'starter', plan_status = 'active' WHERE id = $1`,
      [account.id],
    );
    const portals = fake.calls.portalCreate.length;
    const res = await get(base + buyPath(checkoutLink(t.config, account.id, "pro")));
    expect(res.status).toBe(409);
    expect(fake.calls.portalCreate).toHaveLength(portals);
  });

  it("buys from the account page with a session and CSRF token", async () => {
    const { account } = await makeAccount(t.services, "owner@acme.test");
    const { cookie, csrf } = await signIn(account.id);
    const post = (body: Record<string, string>, withCookie = true) =>
      fetch(`${base}/account/buy`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(withCookie ? { cookie } : {}) },
        body: new URLSearchParams(body),
      });

    const res = await post({ item: "growth", units: "1", csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(fake.calls.checkoutCreate.at(-1)).toMatchObject({ mode: "subscription", client_reference_id: account.id });

    expect((await post({ item: "growth", units: "1" })).status).toBe(403);
    expect((await post({ item: "platinum", units: "1", csrf })).status).toBe(400);
    const signedOut = await post({ item: "growth", units: "1", csrf }, false);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toMatch(/^\/login/);
  });

  it("opens billing for an account with a customer, or goes back to /account", async () => {
    const { account } = await makeAccount(t.services, "billing@acme.test");
    const { cookie } = await signIn(account.id);
    let res = await get(`${base}/account/billing`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account");

    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_billing' WHERE id = $1`, [account.id]);
    res = await get(`${base}/account/billing`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/billing\.stripe\.test\//);
    expect(fake.calls.portalCreate.at(-1)).toMatchObject({ customer: "cus_billing" });
  });
});
