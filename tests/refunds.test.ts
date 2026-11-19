import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PLANS, TOPUP } from "../src/billing/plans.js";
import { processStripeEvent } from "../src/billing/webhooks.js";
import { listen } from "./helpers/browser.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { fakeStripe, WEBHOOK_SECRET } from "./helpers/fakeStripe.js";
import type Stripe from "stripe";

describe.skipIf(!TEST_DATABASE_URL)("refunds", () => {
  let t: TestDb;
  let server: Server;
  const fake = fakeStripe({
    prices: [{ id: "price_starter", lookup_key: PLANS.starter.lookupKey, unit_amount: PLANS.starter.priceCents, active: true }],
    sessionsByPaymentIntent: { pi_topup: { id: "cs_topup", mode: "payment" }, pi_partial: { id: "cs_partial", mode: "payment" }, pi_spent: { id: "cs_spent", mode: "payment" } },
    invoicesByPaymentIntent: { pi_plan: "in_plan" },
  });

  beforeAll(async () => {
    t = await createTestDb({ stripe: fake.stripe, config: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_ALERT_EMAIL: "andrew@whichsitesuse.com" } });
    ({ server } = await listen(createApp({ config: t.config, getSnapshot: () => null, services: t.services })));
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });

  let seq = 0;
  const run = (type: string, object: Record<string, unknown>) =>
    processStripeEvent(t.services, { id: `evt_r${++seq}`, object: "event", type, data: { object } } as unknown as Stripe.Event);
  const topup = (accountId: string, session: string, units: number) =>
    run("checkout.session.completed", {
      id: session, object: "checkout.session", mode: "payment", payment_status: "paid", client_reference_id: accountId,
      customer: null, metadata: { account_id: accountId, item: "topup", units: String(units) },
    });
  const refund = (charge: string, pi: string, amount: number, refunded: number) =>
    run("charge.refunded", { id: charge, object: "charge", payment_intent: pi, amount, amount_refunded: refunded });
  const balance = async (id: string) => (await t.services.ledger.balance(id)).total;

  it("takes back all of a fully refunded top-up, once", async () => {
    const { account } = await makeAccount(t.services, "full@acme.com");
    await topup(account.id, "cs_topup", 2);
    expect(await balance(account.id)).toBe(2 * TOPUP.creditsPerUnit);
    await refund("ch_full", "pi_topup", 3000, 3000);
    expect(await balance(account.id)).toBe(0);
    // A second event for the same refund changes nothing.
    await refund("ch_full", "pi_topup", 3000, 3000);
    const rows = await t.db.query("SELECT amount FROM credit_ledger WHERE account_id = $1 AND kind = 'refund'", [account.id]);
    expect(rows.rows).toEqual([{ amount: -2000 }]);
  });

  it("takes back only the difference as partial refunds add up", async () => {
    const { account } = await makeAccount(t.services, "partial@acme.com");
    await topup(account.id, "cs_partial", 4);
    await refund("ch_partial", "pi_partial", 6000, 1500); // a quarter
    expect(await balance(account.id)).toBe(3000);
    await refund("ch_partial", "pi_partial", 6000, 3000); // half in total
    expect(await balance(account.id)).toBe(2000);
  });

  it("takes back what's left when credits were spent, and alerts the admin", async () => {
    const { account } = await makeAccount(t.services, "spent@acme.com");
    await topup(account.id, "cs_spent", 1);
    await t.services.ledger.spend(account.id, 800, "usage:test");
    t.mailer.sent.length = 0;
    await refund("ch_spent", "pi_spent", 1500, 1500);
    expect(await balance(account.id)).toBe(0);
    await new Promise((r) => setTimeout(r, 50)); // the alert is sent after the transaction
    expect(t.mailer.sent.map((m) => m.template)).toEqual(["adminAlert"]);
    expect(t.mailer.sent[0]!.text).toMatch(/kept 800 credits/);
  });

  it("takes back a refunded plan invoice's credits", async () => {
    const { account } = await makeAccount(t.services, "plan@acme.com");
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    await run("invoice.paid", {
      id: "in_plan", object: "invoice", customer: null, amount_paid: PLANS.starter.priceCents,
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_refund", metadata: { account_id: account.id } } },
      lines: { object: "list", data: [{ id: "il_1", period: { start: end - 30 * 86400, end }, parent: { subscription_item_details: { proration: false } }, pricing: { price_details: { price: "price_starter" } } }] },
    });
    expect(await balance(account.id)).toBe(PLANS.starter.monthlyCredits);
    await refund("ch_plan", "pi_plan", PLANS.starter.priceCents, PLANS.starter.priceCents);
    expect(await balance(account.id)).toBe(0);
  });

  it("ignores a refund it can't match to a purchase", async () => {
    expect(await refund("ch_unknown", "pi_unknown", 1000, 1000)).toBe("processed");
  });
});
