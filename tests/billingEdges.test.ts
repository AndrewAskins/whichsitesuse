import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLANS, TOPUP } from "../src/billing/plans.js";
import { checkoutUrl } from "../src/billing/stripe.js";
import { processStripeEvent } from "../src/billing/webhooks.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { fakeStripe, type FakeStripeOptions, WEBHOOK_SECRET } from "./helpers/fakeStripe.js";

const PRICE = { starter: "price_starter", pro: "price_pro", topup: "price_topup" } as const;
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

/** Out-of-order and unusual Stripe events: late invoices, second plans, upgrades, disputes. */
describe.skipIf(!TEST_DATABASE_URL)("billing edge cases", () => {
  let t: TestDb;
  const opts: FakeStripeOptions = {
    prices: [
      { id: PRICE.starter, lookup_key: PLANS.starter.lookupKey, unit_amount: PLANS.starter.priceCents, active: true },
      { id: PRICE.pro, lookup_key: PLANS.pro.lookupKey, unit_amount: PLANS.pro.priceCents, active: true },
      { id: PRICE.topup, lookup_key: TOPUP.lookupKey, unit_amount: TOPUP.priceCentsPerUnit, active: true },
    ],
    subscriptions: {},
    openSessions: {},
    sessionsByPaymentIntent: { pi_disputed: { id: "cs_disputed", mode: "payment" } },
  };
  const fake = fakeStripe(opts);

  beforeAll(async () => {
    t = await createTestDb({ stripe: fake.stripe, config: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_ALERT_EMAIL: "andrew@whichsitesuse.com" } });
  });
  afterAll(async () => {
    await t?.drop();
  });

  let seq = 0;
  const run = (type: string, object: Record<string, unknown>) =>
    processStripeEvent(t.services, { id: `evt_e${++seq}`, object: "event", type, data: { object } } as unknown as Stripe.Event);
  const balance = (id: string) => t.services.ledger.balance(id);
  const account = async (id: string) => (await t.services.accounts.byId(id))!;

  type Line = { price: string; periodEnd: number; amount?: number; proration?: boolean };
  function invoice(id: string, accountId: string, sub: string, lines: Line[], extra: Record<string, unknown> = {}) {
    return {
      id,
      object: "invoice",
      customer: null,
      amount_paid: 1900,
      billing_reason: "subscription_cycle",
      parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: { account_id: accountId } } },
      lines: {
        object: "list",
        data: lines.map((l, i) => ({
          id: `il_${id}_${i}`,
          object: "line_item",
          amount: l.amount ?? 1900,
          period: { start: l.periodEnd - 30 * DAY, end: l.periodEnd },
          parent: { type: "subscription_item_details", subscription_item_details: { proration: l.proration ?? false, subscription: sub } },
          pricing: { type: "price_details", price_details: { price: l.price, product: "prod_1" } },
        })),
      },
      ...extra,
    };
  }

  it("keeps this month's credits when last month's invoice is paid late", async () => {
    const { account: a } = await makeAccount(t.services, "late@acme.com");
    await run("invoice.paid", invoice("in_now", a.id, "sub_late", [{ price: PRICE.starter, periodEnd: now() + 20 * DAY }]));
    await t.services.ledger.spend(a.id, 1000, "usage:test");
    // The previous period's invoice, retried and paid after the renewal.
    await run("invoice.paid", invoice("in_old", a.id, "sub_late", [{ price: PRICE.starter, periodEnd: now() - 10 * DAY }]));
    expect((await balance(a.id)).plan).toBe(PLANS.starter.monthlyCredits - 1000);
  });

  it("doesn't reset credits for an invoice older than the one already applied", async () => {
    const { account: a } = await makeAccount(t.services, "older@acme.com");
    await run("invoice.paid", invoice("in_next", a.id, "sub_older", [{ price: PRICE.starter, periodEnd: now() + 40 * DAY }]));
    await t.services.ledger.spend(a.id, 500, "usage:test");
    await run("invoice.paid", invoice("in_prev", a.id, "sub_older", [{ price: PRICE.starter, periodEnd: now() + 10 * DAY }]));
    expect((await balance(a.id)).plan).toBe(PLANS.starter.monthlyCredits - 500);
  });

  it("adds nothing for a second live subscription and alerts the admin", async () => {
    const { account: a } = await makeAccount(t.services, "twice@acme.com");
    await run("invoice.paid", invoice("in_first", a.id, "sub_first", [{ price: PRICE.starter, periodEnd: now() + 20 * DAY }]));
    await run("checkout.session.completed", {
      id: "cs_second", object: "checkout.session", mode: "subscription", subscription: "sub_second", customer: "cus_twice",
      client_reference_id: a.id, metadata: { account_id: a.id, item: "pro" },
    });
    await run("invoice.paid", invoice("in_second", a.id, "sub_second", [{ price: PRICE.pro, periodEnd: now() + 30 * DAY }]));
    const row = await account(a.id);
    expect(row.stripe_subscription_id).toBe("sub_first");
    expect(row.plan).toBe("starter");
    expect((await balance(a.id)).plan).toBe(PLANS.starter.monthlyCredits);
    await vi.waitFor(async () => {
      const alerts = await t.db.query(`SELECT 1 FROM admin_alerts WHERE dedupe_key = 'second-subscription:sub_second'`);
      expect(alerts.rowCount).toBe(1);
    });
  });

  it("gives an upgrade only the extra credits for the rest of the month", async () => {
    const { account: a } = await makeAccount(t.services, "upgrade@acme.com");
    const end = now() + 15 * DAY; // half the month left
    await run("invoice.paid", invoice("in_base", a.id, "sub_up", [{ price: PRICE.starter, periodEnd: end }]));
    await t.services.ledger.spend(a.id, 2000, "usage:test");
    // Stripe usually reports the subscription change before the proration invoice.
    opts.subscriptions!.sub_up = { status: "active", customer: "cus_up", metadata: { account_id: a.id }, items: { data: [{ price: PRICE.pro, current_period_end: end }] } };
    await run("customer.subscription.updated", { id: "sub_up", object: "subscription", status: "active", customer: "cus_up", metadata: { account_id: a.id }, items: { data: [{ price: PRICE.pro, current_period_end: end }] } });
    await run(
      "invoice.paid",
      invoice("in_upgrade", a.id, "sub_up", [
        { price: PRICE.starter, periodEnd: end, amount: -950, proration: true },
        { price: PRICE.pro, periodEnd: end, amount: 19950, proration: true },
      ], { billing_reason: "subscription_update", amount_paid: 19000 }),
    );
    const extra = (PLANS.pro.monthlyCredits - PLANS.starter.monthlyCredits) / 2;
    const plan = (await balance(a.id)).plan;
    expect(plan).toBeGreaterThan(PLANS.starter.monthlyCredits - 2000 + extra - 200);
    expect(plan).toBeLessThan(PLANS.starter.monthlyCredits - 2000 + extra + 200);
    expect((await account(a.id)).plan).toBe("pro");
  });

  it("doesn't bring a cancelled plan back when a late update arrives", async () => {
    const { account: a } = await makeAccount(t.services, "cancelled@acme.com");
    const end = now() + 20 * DAY;
    await run("invoice.paid", invoice("in_cancel", a.id, "sub_cancel", [{ price: PRICE.starter, periodEnd: end }]));
    const sub = { id: "sub_cancel", object: "subscription", customer: "cus_c", metadata: { account_id: a.id }, items: { data: [{ price: PRICE.starter, current_period_end: end }] } };
    opts.subscriptions!.sub_cancel = { ...sub, status: "canceled" };
    await run("customer.subscription.deleted", { ...sub, status: "canceled" });
    await run("customer.subscription.updated", { ...sub, status: "active" });
    const row = await account(a.id);
    expect(row.plan).toBe("none");
    expect(row.plan_status).toBe("canceled");
  });

  it("takes back a disputed top-up and suspends the account", async () => {
    const { account: a } = await makeAccount(t.services, "dispute@acme.com");
    await run("checkout.session.completed", {
      id: "cs_disputed", object: "checkout.session", mode: "payment", payment_status: "paid", client_reference_id: a.id,
      customer: null, metadata: { account_id: a.id, item: "topup", units: "2" },
    });
    expect((await balance(a.id)).total).toBe(2 * TOPUP.creditsPerUnit);
    await run("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_disputed", payment_intent: "pi_disputed", amount: 3000, reason: "fraudulent" });
    expect((await balance(a.id)).total).toBe(0);
    expect((await account(a.id)).status).toBe("suspended");
    await vi.waitFor(async () => {
      expect((await t.db.query(`SELECT 1 FROM admin_alerts WHERE dedupe_key = 'dispute:dp_1'`)).rowCount).toBe(1);
    });
  });

  it("sends a plan checkout to the portal when Stripe already has a live subscription", async () => {
    const { account: a } = await makeAccount(t.services, "lagging@acme.com");
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_lag' WHERE id = $1`, [a.id]);
    opts.subscriptions!.sub_lag = { customer: "cus_lag", status: "active" };
    const url = await checkoutUrl(t.services, await account(a.id), "pro");
    expect(url).toMatch(/^https:\/\/billing\.stripe\.test\//);
  });

  it("closes an open plan checkout before opening another", async () => {
    const { account: a } = await makeAccount(t.services, "tabs@acme.com");
    await t.db.query(`UPDATE accounts SET stripe_customer_id = 'cus_tabs' WHERE id = $1`, [a.id]);
    opts.openSessions!.cus_tabs = [
      { id: "cs_open_plan", mode: "subscription" },
      { id: "cs_open_topup", mode: "payment" },
    ];
    const url = await checkoutUrl(t.services, await account(a.id), "starter");
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(fake.calls.sessionsExpire).toEqual(["cs_open_plan"]);
  });
});
