import type Stripe from "stripe";
import type { Account } from "../auth/accounts.js";
import { log } from "../log.js";
import { OperationError } from "../operations/types.js";
import type { Services } from "../services.js";
import { clampUnits } from "./checkoutLinks.js";
import { CHECKOUT_ITEMS, PLANS, TOPUP, type CheckoutItem } from "./plans.js";

/** Stripe price ids for everything we sell, and the way back from a price id. */
export interface PriceIndex {
  byItem: Record<CheckoutItem, string>;
  itemByPrice: Map<string, CheckoutItem>;
}

function lookupKeyFor(item: CheckoutItem): string {
  return item === "topup" ? TOPUP.lookupKey : PLANS[item].lookupKey;
}

function itemForLookupKey(key: string | null | undefined): CheckoutItem | null {
  return CHECKOUT_ITEMS.find((item) => lookupKeyFor(item) === key) ?? null;
}

function createParams(item: CheckoutItem): Stripe.PriceCreateParams {
  const base = {
    currency: "usd",
    lookup_key: lookupKeyFor(item),
    // If the key sits on an archived price, move it here rather than fail.
    transfer_lookup_key: true,
    metadata: { item },
  };
  return item === "topup"
    ? { ...base, unit_amount: TOPUP.priceCentsPerUnit, product_data: { name: `WhichSitesUse ${TOPUP.name} (1,000 credits)` } }
    : { ...base, unit_amount: PLANS[item].priceCents, recurring: { interval: "month" }, product_data: { name: `WhichSitesUse ${PLANS[item].name}` } };
}

// Prices are found by lookup key once per process (per client, so tests stay apart).
const priceCache = new WeakMap<Stripe, Promise<PriceIndex>>();

/**
 * Finds the Stripe price for each plan and the top-up by lookup key, creating
 * the product and price when one is missing, so a fresh Stripe account (or
 * test mode) needs no manual setup and plans.ts stays the only place prices live.
 */
export function ensurePrices(stripe: Stripe): Promise<PriceIndex> {
  let cached = priceCache.get(stripe);
  if (!cached) {
    cached = loadPrices(stripe);
    // A failed lookup shouldn't stick; the next checkout tries again.
    cached.catch(() => priceCache.delete(stripe));
    priceCache.set(stripe, cached);
  }
  return cached;
}

async function loadPrices(stripe: Stripe): Promise<PriceIndex> {
  const found = await stripe.prices.list({ lookup_keys: CHECKOUT_ITEMS.map(lookupKeyFor), active: true, limit: 10 });
  const byItem = {} as Record<CheckoutItem, string>;
  const itemByPrice = new Map<string, CheckoutItem>();
  for (const price of found.data) {
    const item = itemForLookupKey(price.lookup_key);
    if (!item) continue;
    const expected = createParams(item).unit_amount;
    if (price.unit_amount !== expected) {
      log.warn({ item, price: price.id, unit_amount: price.unit_amount, expected }, "Stripe price differs from plans.ts; bump the lookup key");
    }
    byItem[item] = price.id;
    itemByPrice.set(price.id, item);
  }
  for (const item of CHECKOUT_ITEMS) {
    if (byItem[item]) continue;
    const price = await stripe.prices.create(createParams(item));
    log.info({ item, price: price.id }, "created Stripe price");
    byItem[item] = price.id;
    itemByPrice.set(price.id, item);
  }
  return { byItem, itemByPrice };
}

/** What a Stripe price sells: by its lookup key when expanded, else via the price index. */
export async function itemForPrice(stripe: Stripe, price: string | Stripe.Price | null | undefined): Promise<CheckoutItem | null> {
  if (!price) return null;
  if (typeof price !== "string") {
    const byKey = itemForLookupKey(price.lookup_key);
    if (byKey) return byKey;
  }
  const { itemByPrice } = await ensurePrices(stripe);
  return itemByPrice.get(typeof price === "string" ? price : price.id) ?? null;
}

function requireStripe(services: Services): Stripe {
  if (!services.stripe) throw new OperationError("billing_unavailable", "Billing isn't set up on this server yet.");
  return services.stripe;
}

/** Subscription states in which a second plan checkout would start a second subscription. */
export const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due"]);

export function hasActiveSubscription(account: Pick<Account, "stripe_subscription_id" | "plan_status">): boolean {
  return account.stripe_subscription_id !== null && LIVE_SUBSCRIPTION.has(account.plan_status ?? "");
}

/** The account's Stripe customer id, creating the customer the first time. */
export async function ensureCustomer(services: Services, account: Account): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const stripe = requireStripe(services);
  const customer = await stripe.customers.create(
    { email: account.email, metadata: { account_id: account.id } },
    // Two checkouts opened at once create one customer, not two.
    { idempotencyKey: `customer:${account.id}` },
  );
  const { rows } = await services.db.query<{ stripe_customer_id: string }>(
    `UPDATE accounts SET stripe_customer_id = coalesce(stripe_customer_id, $2), updated_at = now()
      WHERE id = $1 RETURNING stripe_customer_id`,
    [account.id, customer.id],
  );
  const id = rows[0]?.stripe_customer_id ?? customer.id;
  account.stripe_customer_id = id;
  return id;
}

/**
 * Where to send someone who wants to buy `item`: a Stripe Checkout session,
 * or, for a plan when the account already has a live subscription, the
 * Billing Portal, where plan changes happen so nobody pays for two plans.
 */
export async function checkoutUrl(services: Services, account: Account, item: CheckoutItem, units = 1): Promise<string> {
  const stripe = requireStripe(services);
  if (item !== "topup" && hasActiveSubscription(account)) return portalUrl(services, account);

  const hadCustomer = account.stripe_customer_id !== null;
  const [customer, prices] = await Promise.all([ensureCustomer(services, account), ensurePrices(stripe)]);
  if (item !== "topup" && hadCustomer) {
    // Our copy of the plan can lag Stripe by a webhook: ask Stripe before starting a second plan.
    const subs = await stripe.subscriptions.list({ customer, status: "all", limit: 10 });
    if (subs.data.some((s) => LIVE_SUBSCRIPTION.has(s.status))) return portalUrl(services, account);
    // A plan checkout left open in another tab would start a second subscription if paid later.
    const open = await stripe.checkout.sessions.list({ customer, status: "open", limit: 10 });
    for (const s of open.data) if (s.mode === "subscription") await stripe.checkout.sessions.expire(s.id);
  }
  const quantity = item === "topup" ? clampUnits(units) : 1;
  // The webhook reads these back to know whose credits and how many.
  const metadata = { account_id: account.id, item, units: String(quantity) };
  const base = services.config.PUBLIC_BASE_URL;
  const session = await stripe.checkout.sessions.create({
    mode: item === "topup" ? "payment" : "subscription",
    customer,
    client_reference_id: account.id,
    line_items: [{ price: prices.byItem[item], quantity }],
    metadata,
    ...(item === "topup" ? { payment_intent_data: { metadata } } : { subscription_data: { metadata } }),
    allow_promotion_codes: false,
    success_url: `${base}/account?paid=1`,
    cancel_url: `${base}/account`,
  });
  if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a URL`);
  return session.url;
}

/** A Billing Portal session for managing the plan, payment method and invoices. */
export async function portalUrl(services: Services, account: Account): Promise<string> {
  const stripe = requireStripe(services);
  const session = await stripe.billingPortal.sessions.create({
    customer: await ensureCustomer(services, account),
    return_url: `${services.config.PUBLIC_BASE_URL}/account`,
  });
  return session.url;
}
