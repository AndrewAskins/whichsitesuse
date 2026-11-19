import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { releaseWithheldGrant } from "../src/auth/freeGrant.js";
import { PLANS, TOPUP } from "../src/billing/plans.js";
import type { Services } from "../src/services.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { fakeStripe, signWebhook, WEBHOOK_SECRET } from "./helpers/fakeStripe.js";

// The real releaseWithheldGrant lives in another change; here we only check it's called on a first payment.
vi.mock("../src/auth/freeGrant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/freeGrant.js")>()),
  releaseWithheldGrant: vi.fn(async () => {}),
}));

const PRICE = { starter: "price_starter", growth: "price_growth", pro: "price_pro", topup: "price_topup" } as const;

describe.skipIf(!TEST_DATABASE_URL)("Stripe webhooks", () => {
  let t: TestDb;
  let server: Server;
  let base: string;
  const fake = fakeStripe({
    prices: [
      { id: PRICE.starter, lookup_key: PLANS.starter.lookupKey, unit_amount: PLANS.starter.priceCents, active: true },
      { id: PRICE.growth, lookup_key: PLANS.growth.lookupKey, unit_amount: PLANS.growth.priceCents, active: true },
      { id: PRICE.pro, lookup_key: PLANS.pro.lookupKey, unit_amount: PLANS.pro.priceCents, active: true },
      { id: PRICE.topup, lookup_key: TOPUP.lookupKey, unit_amount: TOPUP.priceCentsPerUnit, active: true },
    ],
  });

  beforeAll(async () => {
    t = await createTestDb({ stripe: fake.stripe, config: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } });
    server = createApp({ config: t.config, getSnapshot: () => null, services: t.services }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });
  beforeEach(() => vi.mocked(releaseWithheldGrant).mockClear());

  let seq = 0;
  function event(type: string, object: Record<string, unknown>, id = `evt_${++seq}`) {
    return { id, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } };
  }
  async function send(evt: object, opts: { signature?: string; to?: string } = {}) {
    const payload = JSON.stringify(evt);
    return fetch(opts.to ?? `${base}/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": opts.signature ?? signWebhook(payload) },
      body: payload,
    });
  }
  const balance = (accountId: string) => t.services.ledger.balance(accountId);
  const accountRow = async (id: string) => (await t.services.accounts.byId(id))!;

  function topupSession(accountId: string, sessionId: string, units = 3, extra: Record<string, unknown> = {}) {
    return {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      client_reference_id: accountId,
      customer: null,
      metadata: { account_id: accountId, item: "topup", units: String(units) },
      ...extra,
    };
  }

  function invoice(opts: { id: string; accountId?: string; customer?: string; price: unknown; periodEnd: number; sub?: string; amountPaid?: number }) {
    return {
      id: opts.id,
      object: "invoice",
      customer: opts.customer ?? null,
      amount_paid: opts.amountPaid ?? 1900,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: opts.sub ?? "sub_1", metadata: opts.accountId ? { account_id: opts.accountId } : {} },
      },
      lines: {
        object: "list",
        data: [
          {
            id: `il_${opts.id}`,
            object: "line_item",
            period: { start: opts.periodEnd - 30 * 86400, end: opts.periodEnd },
            parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: opts.sub ?? "sub_1" } },
            pricing: { type: "price_details", price_details: { price: opts.price, product: "prod_1" } },
          },
        ],
      },
    };
  }

  it("rejects a bad signature with 400", async () => {
    const res = await send(event("invoice.paid", {}), { signature: "t=1,v1=deadbeef" });
    expect(res.status).toBe(400);
  });

  it("answers 503 when the webhook secret isn't configured", async () => {
    const services: Services = { ...t.services, config: { ...t.config, STRIPE_WEBHOOK_SECRET: undefined } };
    const other = createApp({ config: t.config, getSnapshot: () => null, services }).listen(0);
    await new Promise((r) => other.once("listening", r));
    const res = await send(event("invoice.paid", {}), { to: `http://127.0.0.1:${(other.address() as AddressInfo).port}/stripe/webhook` });
    other.close();
    expect(res.status).toBe(503);
  });

  it("adds a top-up once, however often it is replayed, and marks the first payment", async () => {
    const { account } = await makeAccount(t.services, "topup@acme.test");
    const evt = event("checkout.session.completed", topupSession(account.id, "cs_topup_1"));

    const res = await send(evt);
    expect(res.status).toBe(200);
    expect((await balance(account.id)).topup).toBe(3 * TOPUP.creditsPerUnit);

    // Same event again, and another event for the same session.
    expect(((await (await send(evt)).json()) as { outcome: string }).outcome).toBe("duplicate");
    await send(event("checkout.session.async_payment_succeeded", topupSession(account.id, "cs_topup_1")));
    expect((await balance(account.id)).topup).toBe(3 * TOPUP.creditsPerUnit);

    const { rows } = await t.db.query<{ expires_at: Date }>(`SELECT expires_at FROM credit_lots WHERE account_id = $1 AND bucket = 'topup'`, [account.id]);
    const months = (rows[0]!.expires_at.getTime() - Date.now()) / (30.4 * 86400_000);
    expect(Math.round(months)).toBe(TOPUP.validMonths);

    expect((await accountRow(account.id)).first_paid_at).not.toBeNull();
    expect(releaseWithheldGrant).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseWithheldGrant).mock.calls[0]![1]).toBe(account.id);
  });

  it("waits for an async payment to succeed before adding a top-up", async () => {
    const { account } = await makeAccount(t.services, "async@acme.test");
    await send(event("checkout.session.completed", topupSession(account.id, "cs_async", 1, { payment_status: "unpaid" })));
    expect((await balance(account.id)).topup).toBe(0);
    await send(event("checkout.session.async_payment_succeeded", topupSession(account.id, "cs_async", 1)));
    expect((await balance(account.id)).topup).toBe(TOPUP.creditsPerUnit);
  });

  it("does not release the grant again for an account that has paid before", async () => {
    const { account } = await makeAccount(t.services, "repeat@acme.test", { paid: true });
    await send(event("checkout.session.completed", topupSession(account.id, "cs_repeat", 1)));
    expect((await balance(account.id)).topup).toBe(TOPUP.creditsPerUnit);
    expect(releaseWithheldGrant).not.toHaveBeenCalled();
  });

  it("links a subscription checkout to the account without adding credits", async () => {
    const { account } = await makeAccount(t.services, "subcheckout@acme.test");
    await send(
      event("checkout.session.completed", {
        id: "cs_sub",
        object: "checkout.session",
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: account.id,
        customer: "cus_subcheckout",
        subscription: "sub_subcheckout",
        metadata: { account_id: account.id, item: "starter", units: "1" },
      }),
    );
    const row = await accountRow(account.id);
    expect(row).toMatchObject({ stripe_customer_id: "cus_subcheckout", stripe_subscription_id: "sub_subcheckout", first_paid_at: null });
    expect((await balance(account.id)).total).toBe(0);
  });

  it("resets plan credits on invoice.paid, once per invoice", async () => {
    const { account } = await makeAccount(t.services, "plan@acme.test", { credits: 500, bucket: "plan" });
    const end1 = Math.floor(Date.now() / 1000) + 30 * 86400;
    // Price expanded with its lookup key.
    const first = event("invoice.paid", invoice({ id: "in_1", accountId: account.id, price: { id: PRICE.starter, lookup_key: PLANS.starter.lookupKey }, periodEnd: end1 }));
    expect((await send(first)).status).toBe(200);
    expect((await balance(account.id)).plan).toBe(PLANS.starter.monthlyCredits);

    let row = await accountRow(account.id);
    expect(row).toMatchObject({ plan: "starter", plan_status: "active", stripe_subscription_id: "sub_1" });
    expect(row.plan_renews_at!.getTime()).toBe(end1 * 1000);
    expect(row.first_paid_at).not.toBeNull();
    const lot = await t.db.query<{ expires_at: Date }>(`SELECT expires_at FROM credit_lots WHERE account_id = $1 AND bucket = 'plan' AND remaining > 0`, [account.id]);
    expect(lot.rows[0]!.expires_at.getTime()).toBe((end1 + 86400) * 1000);

    // A replay under a new event id neither resets nor adds.
    await t.services.ledger.spend(account.id, 1000, "test-spend");
    await send(event("invoice.paid", invoice({ id: "in_1", accountId: account.id, price: PRICE.starter, periodEnd: end1 })));
    expect((await balance(account.id)).plan).toBe(PLANS.starter.monthlyCredits - 1000);

    // Next month, price as a bare id (found through the price index): reset, not added.
    const end2 = end1 + 30 * 86400;
    await send(event("invoice.paid", invoice({ id: "in_2", accountId: account.id, price: PRICE.growth, periodEnd: end2 })));
    expect((await balance(account.id)).plan).toBe(PLANS.growth.monthlyCredits);
    row = await accountRow(account.id);
    expect(row.plan).toBe("growth");
    expect(row.plan_renews_at!.getTime()).toBe(end2 * 1000);

    const expired = await t.db.query(`SELECT 1 FROM credit_ledger WHERE account_id = $1 AND kind = 'expire'`, [account.id]);
    expect(expired.rowCount).toBe(2);
  });

  it("finds the account by Stripe customer when metadata is missing", async () => {
    const { account } = await makeAccount(t.services, "bycustomer@acme.test");
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_bycustomer' WHERE id = $1`, [account.id]);
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await send(event("invoice.paid", invoice({ id: "in_bycustomer", customer: "cus_bycustomer", price: PRICE.pro, periodEnd: end, sub: "sub_bc" })));
    expect((await balance(account.id)).plan).toBe(PLANS.pro.monthlyCredits);
  });

  it("doesn't count a $0 invoice as the first payment", async () => {
    const { account } = await makeAccount(t.services, "zero@acme.test");
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await send(event("invoice.paid", invoice({ id: "in_zero", accountId: account.id, price: PRICE.starter, periodEnd: end, sub: "sub_zero", amountPaid: 0 })));
    expect((await balance(account.id)).plan).toBe(PLANS.starter.monthlyCredits);
    expect((await accountRow(account.id)).first_paid_at).toBeNull();
    expect(releaseWithheldGrant).not.toHaveBeenCalled();
  });

  it("tracks subscription updates and cancellation", async () => {
    const { account } = await makeAccount(t.services, "sub@acme.test", { credits: 5000, bucket: "plan" });
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_sub', stripe_subscription_id = 'sub_live', plan = 'starter', plan_status = 'active' WHERE id = $1`, [account.id]);
    const end = Math.floor(Date.now() / 1000) + 20 * 86400;
    const sub = (status: string, price: string) => ({
      id: "sub_live",
      object: "subscription",
      customer: "cus_sub",
      status,
      metadata: { account_id: account.id },
      items: { object: "list", data: [{ id: "si_1", price: { id: price }, current_period_end: end }] },
    });

    await send(event("customer.subscription.updated", sub("past_due", PRICE.growth)));
    let row = await accountRow(account.id);
    expect(row).toMatchObject({ plan: "growth", plan_status: "past_due" });
    expect(row.plan_renews_at!.getTime()).toBe(end * 1000);

    // An event for some other, older subscription leaves the current one alone.
    await send(event("customer.subscription.deleted", { ...sub("canceled", PRICE.starter), id: "sub_old" }));
    expect((await accountRow(account.id)).plan).toBe("growth");

    await send(event("customer.subscription.deleted", sub("canceled", PRICE.growth)));
    row = await accountRow(account.id);
    expect(row).toMatchObject({ plan: "none", plan_status: "canceled", stripe_subscription_id: null });
    expect((await balance(account.id)).plan).toBe(5000);
  });

  it("records unknown events and changes nothing", async () => {
    const evt = event("customer.created", { id: "cus_new", object: "customer" });
    const res = await send(evt);
    expect(res.status).toBe(200);
    const { rows } = await t.db.query(`SELECT type FROM stripe_events WHERE id = $1`, [evt.id]);
    expect(rows).toEqual([{ type: "customer.created" }]);
  });
});
