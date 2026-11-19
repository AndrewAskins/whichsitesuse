import type { Request, Response } from "express";
import type pg from "pg";
import type Stripe from "stripe";
import type { Account } from "../auth/accounts.js";
import { releaseWithheldGrant } from "../auth/freeGrant.js";
import { withTransaction } from "../db/pool.js";
import { log } from "../log.js";
import type { Services } from "../services.js";
import { clampUnits } from "./checkoutLinks.js";
import { PLANS, TOPUP, type PlanId } from "./plans.js";
import { itemForPrice } from "./stripe.js";

const DAY_MS = 24 * 3600 * 1000;

/** POST /stripe/webhook, mounted with express.raw() so the signature can be checked. */
export function stripeWebhookHandler(services: Services) {
  return async (req: Request, res: Response) => {
    const secret = services.config.STRIPE_WEBHOOK_SECRET;
    if (!services.stripe || !secret) {
      res.status(503).json({ error: "billing not configured" });
      return;
    }
    const signature = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      if (!Buffer.isBuffer(req.body) || typeof signature !== "string") throw new Error("missing body or signature");
      event = services.stripe.webhooks.constructEvent(req.body, signature, secret);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "rejected Stripe webhook: bad signature");
      res.status(400).json({ error: "invalid signature" });
      return;
    }
    try {
      const outcome = await processStripeEvent(services, event);
      res.json({ received: true, outcome });
    } catch (err) {
      // A 500 makes Stripe retry; nothing was recorded, so the retry starts clean.
      log.error({ err, event_id: event.id, type: event.type }, "Stripe webhook failed");
      res.status(500).json({ error: "processing failed" });
    }
  };
}

/**
 * The plan a subscription event points at (and, for an invoice, the end of the
 * period it pays for), resolved before the transaction since it may call Stripe.
 */
type Prepared = { plan: PlanId | null; periodEnd?: number };

/**
 * Applies one verified event. The event id is recorded in the same transaction
 * as its effects, so a retried delivery changes nothing and a failed one can
 * be retried in full.
 */
export async function processStripeEvent(services: Services, event: Stripe.Event): Promise<"processed" | "duplicate"> {
  const prepared = await prepare(services, event);
  return withTransaction(services.db, async (c) => {
    const fresh = await c.query(`INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`, [
      event.id,
      event.type,
    ]);
    if (!fresh.rowCount) {
      log.info({ event_id: event.id, type: event.type }, "Stripe event already processed");
      return "duplicate";
    }
    await apply(services, event, prepared, c);
    return "processed";
  });
}

async function prepare(services: Services, event: Stripe.Event): Promise<Prepared> {
  const stripe = services.stripe!;
  if (event.type === "invoice.paid") return planForInvoice(stripe, event.data.object as Stripe.Invoice);
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    return { plan: asPlan(await itemForPrice(stripe, sub.items?.data[0]?.price)) };
  }
  return { plan: null };
}

async function apply(services: Services, event: Stripe.Event, prepared: Prepared, c: pg.PoolClient): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return checkoutCompleted(services, event, event.data.object as Stripe.Checkout.Session, c);
    case "invoice.paid":
      return invoicePaid(services, event, event.data.object as Stripe.Invoice, prepared, c);
    case "customer.subscription.updated":
      return subscriptionUpdated(services, event, event.data.object as Stripe.Subscription, prepared.plan, c);
    case "customer.subscription.deleted":
      return subscriptionDeleted(services, event, event.data.object as Stripe.Subscription, c);
    default:
      log.info({ event_id: event.id, type: event.type }, "Stripe event recorded, no handler");
  }
}

// --- Handlers ---------------------------------------------------------------

async function checkoutCompleted(services: Services, event: Stripe.Event, session: Stripe.Checkout.Session, c: pg.PoolClient) {
  const account = await findAccount(services, c, {
    accountId: session.metadata?.account_id ?? session.client_reference_id,
    customer: session.customer,
  });
  if (!account) return missingAccount(event);

  if (session.mode === "subscription") {
    // Credits come with invoice.paid; this only links the subscription to the account.
    await c.query(
      `UPDATE accounts SET stripe_customer_id = coalesce($2, stripe_customer_id),
              stripe_subscription_id = coalesce($3, stripe_subscription_id), updated_at = now() WHERE id = $1`,
      [account.id, idOf(session.customer), idOf(session.subscription)],
    );
    log.info({ event_id: event.id, account_id: account.id }, "subscription checkout completed");
    return;
  }

  if (session.mode !== "payment" || session.payment_status !== "paid") return;
  if (session.metadata?.item !== "topup") {
    log.warn({ event_id: event.id, session: session.id }, "paid checkout session is not a top-up; ignored");
    return;
  }
  const units = clampUnits(Number(session.metadata.units));
  const expiresAt = new Date();
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + TOPUP.validMonths);
  const added = await services.ledger.addLot(
    {
      accountId: account.id,
      bucket: "topup",
      kind: "topup",
      credits: units * TOPUP.creditsPerUnit,
      ref: session.id,
      expiresAt,
      note: `${units} top-up unit(s)`,
    },
    c,
  );
  if (!added) return;
  log.info({ event_id: event.id, account_id: account.id, units }, "top-up credited");
  await markFirstPaid(services, account, c);
}

async function invoicePaid(services: Services, event: Stripe.Event, invoice: Stripe.Invoice, { plan, periodEnd: end }: Prepared, c: pg.PoolClient) {
  const subscriptionId = invoiceSubscription(invoice);
  if (!subscriptionId) return; // Not a subscription invoice.
  if (!plan || !end) {
    log.error({ event_id: event.id, invoice: invoice.id }, "paid subscription invoice has no known plan price");
    return;
  }
  const account = await findAccount(services, c, {
    accountId: invoice.parent?.subscription_details?.metadata?.account_id,
    customer: invoice.customer,
  });
  if (!account) return missingAccount(event);

  // Replays (or a second event for the same invoice) must neither reset nor add.
  const seen = await c.query(`SELECT 1 FROM credit_ledger WHERE kind = 'plan' AND ref = $1 LIMIT 1`, [invoice.id]);
  if (seen.rowCount) return;

  const periodEnd = new Date(end * 1000);
  // Plan credits don't roll over: last month's unspent ones go when the new month's arrive.
  await services.ledger.clearBucket(account.id, "expire", { bucket: "plan", ref: invoice.id, note: "plan renewal" }, c);
  await services.ledger.addLot(
    {
      accountId: account.id,
      bucket: "plan",
      kind: "plan",
      credits: PLANS[plan].monthlyCredits,
      ref: invoice.id,
      // A day's grace so a late renewal webhook doesn't leave a gap.
      expiresAt: new Date(periodEnd.getTime() + DAY_MS),
      note: `${PLANS[plan].name} plan`,
    },
    c,
  );
  await c.query(
    `UPDATE accounts SET plan = $2, plan_status = 'active', plan_renews_at = $3, stripe_subscription_id = $4,
            stripe_customer_id = coalesce(stripe_customer_id, $5), updated_at = now() WHERE id = $1`,
    [account.id, plan, periodEnd, subscriptionId, idOf(invoice.customer)],
  );
  log.info({ event_id: event.id, account_id: account.id, plan }, "plan credits renewed");
  // A $0 invoice isn't a payment, so it doesn't lift the trial caps.
  if (invoice.amount_paid > 0) await markFirstPaid(services, account, c);
}

async function subscriptionUpdated(services: Services, event: Stripe.Event, sub: Stripe.Subscription, plan: PlanId | null, c: pg.PoolClient) {
  const account = await findAccount(services, c, { accountId: sub.metadata?.account_id, customer: sub.customer });
  if (!account) return missingAccount(event);
  if (!isCurrentSubscription(account, sub)) return;
  const periodEnd = sub.items?.data[0]?.current_period_end;
  await c.query(
    `UPDATE accounts SET plan = coalesce($2, plan), plan_status = $3, plan_renews_at = coalesce($4, plan_renews_at),
            stripe_subscription_id = $5, updated_at = now() WHERE id = $1`,
    [account.id, plan, sub.status, periodEnd ? new Date(periodEnd * 1000) : null, sub.id],
  );
  log.info({ event_id: event.id, account_id: account.id, plan, status: sub.status }, "subscription updated");
}

async function subscriptionDeleted(services: Services, event: Stripe.Event, sub: Stripe.Subscription, c: pg.PoolClient) {
  const account = await findAccount(services, c, { accountId: sub.metadata?.account_id, customer: sub.customer });
  if (!account) return missingAccount(event);
  if (!isCurrentSubscription(account, sub)) return;
  // Plan credits already granted run out at their own expiry.
  await c.query(
    `UPDATE accounts SET plan = 'none', plan_status = 'canceled', plan_renews_at = NULL,
            stripe_subscription_id = NULL, updated_at = now() WHERE id = $1`,
    [account.id],
  );
  log.info({ event_id: event.id, account_id: account.id }, "subscription canceled");
}

// --- Helpers ----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account an event belongs to, locked for the rest of the transaction so
 * two events for one account (say, a renewal and a plan change) apply in turn.
 */
async function findAccount(
  services: Services,
  c: pg.PoolClient,
  by: { accountId?: string | null; customer?: string | { id: string } | null },
): Promise<Account | null> {
  let id = by.accountId && UUID.test(by.accountId) ? by.accountId : null;
  if (!id) {
    const customerId = idOf(by.customer);
    id = customerId ? ((await services.accounts.byStripeCustomer(customerId, c))?.id ?? null) : null;
  }
  if (!id) return null;
  await c.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [id]);
  return services.accounts.byId(id, c);
}

function missingAccount(event: Stripe.Event) {
  // Recorded anyway: a retry wouldn't find the account either. Needs a look by hand.
  log.error({ event_id: event.id, type: event.type }, "Stripe event matches no account");
}

/** Events about an older, replaced subscription don't touch the current plan. */
function isCurrentSubscription(account: Account, sub: Stripe.Subscription): boolean {
  if (account.stripe_subscription_id === null || account.stripe_subscription_id === sub.id) return true;
  log.warn({ account_id: account.id, subscription: sub.id }, "event for a subscription the account no longer uses; ignored");
  return false;
}

/** On the first payment the trial caps lift and a withheld free grant is released. */
async function markFirstPaid(services: Services, account: Account, c: pg.PoolClient) {
  const res = await c.query(`UPDATE accounts SET first_paid_at = now(), updated_at = now() WHERE id = $1 AND first_paid_at IS NULL`, [account.id]);
  if (res.rowCount) await releaseWithheldGrant(services, account.id, c);
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function invoiceSubscription(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

function linePrice(line: Stripe.InvoiceLineItem): string | Stripe.Price | null {
  return line.pricing?.price_details?.price ?? null;
}

/** The plan on an invoice: from its regular subscription line for the latest period. */
async function planForInvoice(stripe: Stripe, invoice: Stripe.Invoice): Promise<Prepared> {
  if (!invoiceSubscription(invoice)) return { plan: null };
  for (const line of sortedLines(invoice)) {
    const plan = asPlan(await itemForPrice(stripe, linePrice(line)));
    if (plan) return { plan, periodEnd: line.period.end };
  }
  return { plan: null };
}

/** Regular lines before prorations, latest period first. */
function sortedLines(invoice: Stripe.Invoice): Stripe.InvoiceLineItem[] {
  const proration = (l: Stripe.InvoiceLineItem) => (l.parent?.subscription_item_details?.proration ? 1 : 0);
  return [...(invoice.lines?.data ?? [])].sort((a, b) => proration(a) - proration(b) || b.period.end - a.period.end);
}

function asPlan(item: string | null): PlanId | null {
  return item && item in PLANS ? (item as PlanId) : null;
}
