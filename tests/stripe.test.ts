import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLANS, TOPUP } from "../src/billing/plans.js";
import { checkoutUrl, ensureCustomer, ensurePrices, itemForPrice, portalUrl } from "../src/billing/stripe.js";
import { OperationError } from "../src/operations/types.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";
import { fakeStripe } from "./helpers/fakeStripe.js";

describe("ensurePrices", () => {
  it("creates each missing price from plans.ts and caches the result", async () => {
    const fake = fakeStripe();
    const index = await ensurePrices(fake.stripe);

    // Four plans and the top-up.
    expect(fake.calls.pricesCreate).toHaveLength(5);
    const starter = fake.calls.pricesCreate.find((p) => p.lookup_key === PLANS.starter.lookupKey);
    expect(starter).toMatchObject({ currency: "usd", unit_amount: 4900, recurring: { interval: "month" }, product_data: { name: expect.any(String) } });
    const scale = fake.calls.pricesCreate.find((p) => p.lookup_key === PLANS.scale.lookupKey);
    expect(scale).toMatchObject({ unit_amount: 99900, recurring: { interval: "month" } });
    const topup = fake.calls.pricesCreate.find((p) => p.lookup_key === TOPUP.lookupKey);
    expect(topup).toMatchObject({ currency: "usd", unit_amount: TOPUP.priceCentsPerUnit });
    expect(topup).not.toHaveProperty("recurring");

    expect(index.itemByPrice.get(index.byItem.growth)).toBe("growth");
    expect(await ensurePrices(fake.stripe)).toBe(index);
    expect(fake.calls.pricesList).toHaveLength(1);
  });

  it("uses prices that already exist", async () => {
    const fake = fakeStripe({
      prices: [{ id: "price_pro", lookup_key: PLANS.pro.lookupKey, unit_amount: PLANS.pro.priceCents, active: true }],
    });
    const index = await ensurePrices(fake.stripe);
    expect(index.byItem.pro).toBe("price_pro");
    expect(fake.calls.pricesCreate.map((p) => p.lookup_key)).not.toContain(PLANS.pro.lookupKey);
  });

  it("maps a price to its item by lookup key or id", async () => {
    const fake = fakeStripe({ prices: [{ id: "price_g", lookup_key: PLANS.growth.lookupKey, unit_amount: 4900, active: true }] });
    expect(await itemForPrice(fake.stripe, "price_g")).toBe("growth");
    expect(await itemForPrice(fake.stripe, { id: "price_x", lookup_key: TOPUP.lookupKey } as never)).toBe("topup");
    expect(await itemForPrice(fake.stripe, "price_unknown")).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("checkout and customers", () => {
  let t: TestDb;
  const fake = fakeStripe();
  beforeAll(async () => {
    t = await createTestDb({ stripe: fake.stripe, config: { PUBLIC_BASE_URL: "https://wsu.test" } });
  });
  afterAll(() => t?.drop());

  it("creates the Stripe customer once and saves it", async () => {
    const { account } = await makeAccount(t.services, "cust@acme.test");
    const id = await ensureCustomer(t.services, account);
    expect(await ensureCustomer(t.services, (await t.services.accounts.byId(account.id))!)).toBe(id);
    const created = fake.calls.customersCreate.filter((c) => (c.params.metadata as { account_id: string }).account_id === account.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toMatchObject({ email: "cust@acme.test" });
    expect((await t.services.accounts.byId(account.id))!.stripe_customer_id).toBe(id);
  });

  it("opens a top-up checkout in payment mode with the units as quantity", async () => {
    const { account } = await makeAccount(t.services, "topup@acme.test");
    const url = await checkoutUrl(t.services, account, "topup", 250);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const params = fake.calls.checkoutCreate.at(-1)!;
    const prices = await ensurePrices(fake.stripe);
    const metadata = { account_id: account.id, item: "topup", units: String(TOPUP.maxUnits) };
    expect(params).toMatchObject({
      mode: "payment",
      client_reference_id: account.id,
      customer: expect.stringMatching(/^cus_/),
      line_items: [{ price: prices.byItem.topup, quantity: TOPUP.maxUnits }],
      metadata,
      payment_intent_data: { metadata },
      allow_promotion_codes: false,
      success_url: "https://wsu.test/account?paid=1",
      cancel_url: "https://wsu.test/account",
    });
    expect(params).not.toHaveProperty("subscription_data");
  });

  it("opens a plan checkout in subscription mode", async () => {
    const { account } = await makeAccount(t.services, "plan@acme.test");
    await checkoutUrl(t.services, account, "growth", 5);
    const params = fake.calls.checkoutCreate.at(-1)!;
    const metadata = { account_id: account.id, item: "growth", units: "1" };
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: (await ensurePrices(fake.stripe)).byItem.growth, quantity: 1 }],
      metadata,
      subscription_data: { metadata },
    });
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("sends a subscribed account to the portal for plans, but still sells top-ups", async () => {
    const { account } = await makeAccount(t.services, "subbed@acme.test");
    await t.db.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_subbed', stripe_subscription_id = 'sub_1', plan = 'starter', plan_status = 'active' WHERE id = $1`,
      [account.id],
    );
    const subbed = (await t.services.accounts.byId(account.id))!;
    const before = fake.calls.checkoutCreate.length;
    expect(await checkoutUrl(t.services, subbed, "pro")).toMatch(/^https:\/\/billing\.stripe\.test\//);
    expect(fake.calls.checkoutCreate).toHaveLength(before);
    expect(fake.calls.portalCreate.at(-1)).toEqual({ customer: "cus_subbed", return_url: "https://wsu.test/account" });

    expect(await checkoutUrl(t.services, subbed, "topup", 1)).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });

  it("opens a portal session for the account's customer", async () => {
    const { account } = await makeAccount(t.services, "portal@acme.test");
    expect(await portalUrl(t.services, account)).toMatch(/^https:\/\/billing\.stripe\.test\//);
  });

  it("answers billing_unavailable without Stripe", async () => {
    const { account } = await makeAccount(t.services, "nostripe@acme.test");
    const err = await checkoutUrl({ ...t.services, stripe: null }, account, "topup", 1).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe("billing_unavailable");
  });
});
