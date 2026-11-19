import type { Request, Response } from "express";
import type pg from "pg";
import type Stripe from "stripe";
import type { Account } from "../auth/accounts.js";
import { alertAdmin } from "../abuse/alerts.js";
import { releaseWithheldGrant } from "../auth/freeGrant.js";
import { withTransaction } from "../db/pool.js";
import { log } from "../log.js";
import type { Services } from "../services.js";
import { clampUnits } from "./checkoutLinks.js";
import { PLANS, TOPUP, type PlanId } from "./plans.js";
import { LIVE_SUBSCRIPTION, itemForPrice } from "./stripe.js";

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
type Prepared = {
  plan: PlanId | null;
  periodEnd?: number;
  /** For a refund or dispute: the checkout session or invoice whose credits it takes back. */
  source?: string | null;
  /** For a plan-change invoice: the plan it moved from. */
  previousPlan?: PlanId | null;
  /** For subscription events: the subscription as Stripe has it now, not as the event saw it. */
  subscription?: Stripe.Subscription;
};

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
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    // Stripe doesn't promise event order, so apply the subscription's current state: a late
    // "updated (active)" after "deleted" must not bring a cancelled plan back.
    const sub = await currentSubscription(stripe, event.data.object as Stripe.Subscription);
    return { plan: asPlan(await itemForPrice(stripe, sub.items?.data[0]?.price)), subscription: sub };
  }
  if (event.type === "charge.refunded") {
    return { plan: null, source: await paymentSource(stripe, idOf((event.data.object as Stripe.Charge).payment_intent)) };
  }
  if (event.type === "charge.dispute.created") {
    return { plan: null, source: await paymentSource(stripe, idOf((event.data.object as Stripe.Dispute).payment_intent)) };
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
    case "customer.subscription.deleted": {
      const sub = prepared.subscription ?? (event.data.object as Stripe.Subscription);
      return ENDED_SUBSCRIPTION.has(sub.status)
        ? subscriptionDeleted(services, event, sub, c)
        : subscriptionUpdated(services, event, sub, prepared.plan, c);
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      await takeBack(services, event, { charge: charge.id, amount: charge.amount, refunded: charge.amount_refunded, source: prepared.source ?? null }, c);
      return;
    }
    case "charge.dispute.created":
      return disputeCreated(services, event, event.data.object as Stripe.Dispute, prepared.source ?? null, c);
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
    const subId = idOf(session.subscription);
    if (subId && isSecondSubscription(account, subId)) {
      await secondSubscriptionAlert(services, account, subId);
      return;
    }
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

async function invoicePaid(services: Services, event: Stripe.Event, invoice: Stripe.Invoice, prepared: Prepared, c: pg.PoolClient) {
  const { plan, periodEnd: end } = prepared;
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

  if (isSecondSubscription(account, subscriptionId)) {
    await secondSubscriptionAlert(services, account, subscriptionId);
    return;
  }

  const periodEnd = new Date(end * 1000);
  const newExpiry = new Date(periodEnd.getTime() + DAY_MS);
  // A late invoice for a period that's over (say, a past-due retry that finally succeeded), or one
  // older than what's already applied, mustn't wipe the current month's credits.
  const stale = async () => {
    log.warn({ event_id: event.id, account_id: account.id, invoice: invoice.id }, "paid invoice is for an earlier period; credits unchanged");
    if (invoice.amount_paid > 0) await markFirstPaid(services, account, c);
  };
  if (newExpiry.getTime() <= Date.now()) return stale();

  if (invoice.billing_reason === "subscription_update") {
    return planChanged(services, event, account, invoice, { plan, previousPlan: prepared.previousPlan ?? null }, periodEnd, newExpiry, subscriptionId, c);
  }

  const newer = await c.query(
    `SELECT 1 FROM credit_lots WHERE account_id = $1 AND bucket = 'plan' AND expires_at >= $2 LIMIT 1`,
    [account.id, newExpiry],
  );
  if (newer.rowCount) return stale();

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
      expiresAt: newExpiry,
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

/**
 * A mid-period plan change billed right away. The new plan's credits arrive in
 * full at the next renewal; for now the account gets only the extra credits for
 * the part of the month that's left (an upgrade with a day to go buys a day's
 * worth, not a month's), and keeps the credits it has. Downgrades add nothing.
 */
async function planChanged(
  services: Services,
  event: Stripe.Event,
  account: Account,
  invoice: Stripe.Invoice,
  { plan, previousPlan }: { plan: PlanId; previousPlan: PlanId | null },
  periodEnd: Date,
  expiresAt: Date,
  subscriptionId: string,
  c: pg.PoolClient,
) {
  // The plan it moved from is on the invoice's credit line for unused time; the account row may
  // already show the new plan, since customer.subscription.updated usually arrives first.
  const from = previousPlan ?? (account.plan === "none" ? null : account.plan);
  const before = from ? PLANS[from].monthlyCredits : 0;
  const left = Math.min(1, Math.max(0, (periodEnd.getTime() - Date.now()) / (30 * DAY_MS)));
  const extra = Math.round(Math.max(0, PLANS[plan].monthlyCredits - before) * left);
  if (extra > 0 && invoice.amount_paid > 0) {
    await services.ledger.addLot(
      { accountId: account.id, bucket: "plan", kind: "plan", credits: extra, ref: invoice.id, expiresAt, note: `Upgrade to ${PLANS[plan].name}` },
      c,
    );
  }
  await c.query(
    `UPDATE accounts SET plan = $2, plan_status = 'active', plan_renews_at = $3, stripe_subscription_id = $4, updated_at = now() WHERE id = $1`,
    [account.id, plan, periodEnd, subscriptionId],
  );
  log.info({ event_id: event.id, account_id: account.id, plan, extra }, "plan changed mid-period");
  if (invoice.amount_paid > 0) await markFirstPaid(services, account, c);
}

/** A chargeback: take back what the payment bought, suspend the account and tell the admin. */
async function disputeCreated(services: Services, event: Stripe.Event, dispute: Stripe.Dispute, source: string | null, c: pg.PoolClient) {
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return;
  const accountId = await takeBack(services, event, { charge: chargeId, amount: dispute.amount, refunded: dispute.amount, source }, c);
  if (!accountId) return;
  await services.accounts.setSuspended(accountId, true, "Card payment disputed", c);
  void alertAdmin(
    services,
    "dispute",
    `dispute:${dispute.id}`,
    "A payment was disputed",
    `Charge ${chargeId} was disputed (${dispute.reason}). The credits it bought were taken back and account ${accountId} is suspended. ` +
      "Respond to the dispute in Stripe, and unsuspend the account in the admin view if it's resolved.",
  );
}

/**
 * A refund takes back the same share of the credits that payment bought (a full
 * refund takes them all), from what's left of that purchase. Credits already
 * spent can't come back, so a shortfall goes to the admin as an alert.
 * Stripe sends charge.refunded again for each partial refund, with the running
 * total, so this takes only the difference from what earlier refunds took.
 */
async function takeBack(
  services: Services,
  event: Stripe.Event,
  charge: { charge: string; amount: number; refunded: number; source: string | null },
  c: pg.PoolClient,
): Promise<string | null> {
  const source = charge.source;
  if (!source) {
    log.warn({ event_id: event.id, charge: charge.charge }, "refund or dispute matches no top-up or plan payment; credits unchanged");
    return null;
  }
  const { rows } = await c.query<{ lot_id: string; account_id: string; original: number }>(
    `SELECT l.id AS lot_id, l.account_id, l.original FROM credit_ledger g JOIN credit_lots l ON l.id = g.lot_id
      WHERE g.kind IN ('topup', 'plan') AND g.ref = $1 LIMIT 1`,
    [source],
  );
  const lot = rows[0];
  if (!lot) {
    log.warn({ event_id: event.id, charge: charge.charge, source }, "refunded payment never added credits; nothing to take back");
    return null;
  }
  const share = charge.amount > 0 ? Math.min(1, charge.refunded / charge.amount) : 1;
  const target = Math.round(lot.original * share);
  const prior = await c.query<{ taken: string | null }>(
    `SELECT (-sum(amount))::text AS taken FROM credit_ledger WHERE kind = 'refund' AND ref LIKE $1`,
    [`refund:${charge.charge}:%`],
  );
  const owed = target - Number(prior.rows[0]?.taken ?? 0);
  if (owed <= 0) return lot.account_id;
  const taken = await services.ledger.debitLot(
    lot.lot_id,
    owed,
    { kind: "refund", ref: `refund:${charge.charge}:${charge.refunded}`, note: "Refunded or disputed payment" },
    c,
  );
  log.info({ event_id: event.id, account_id: lot.account_id, owed, taken }, "refund took credits back");
  if (taken < owed) {
    // Outside the transaction on purpose: the alert is worth keeping even if this event is retried.
    void alertAdmin(
      services,
      "refund_shortfall",
      `refund-shortfall:${charge.charge}:${charge.refunded}`,
      "Refunded credits were already spent",
      `A refund or dispute on charge ${charge.charge} should have taken back ${owed} credits, but only ${taken} were left. ` +
        `Account ${lot.account_id} kept ${owed - taken} credits it no longer paid for.`,
    );
  }
  return lot.account_id;
}

/** The checkout session (top-ups) or invoice (plans) a payment intent paid for. */
async function paymentSource(stripe: Stripe, pi: string | null): Promise<string | null> {
  if (!pi) return null;
  const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
  if (sessions.data[0]?.mode === "payment") return sessions.data[0].id;
  const payments = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
  return idOf(payments.data[0]?.invoice as string | { id: string } | null | undefined);
}

// --- Helpers ----------------------------------------------------------------

/** Subscription states that end the plan. */
const ENDED_SUBSCRIPTION = new Set(["canceled", "incomplete_expired"]);

/** The subscription as Stripe has it now; the event's copy only if Stripe no longer knows it. */
async function currentSubscription(stripe: Stripe, sub: Stripe.Subscription): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(sub.id);
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return sub;
    throw err;
  }
}

/** A paid subscription that isn't the account's live one: someone ended up with two plans. */
function isSecondSubscription(account: Account, subscriptionId: string): boolean {
  return (
    account.stripe_subscription_id !== null &&
    account.stripe_subscription_id !== subscriptionId &&
    LIVE_SUBSCRIPTION.has(account.plan_status ?? "")
  );
}

async function secondSubscriptionAlert(services: Services, account: Account, subscriptionId: string) {
  log.error({ account_id: account.id, subscription: subscriptionId }, "second live subscription for one account; credits unchanged");
  void alertAdmin(
    services,
    "second_subscription",
    `second-subscription:${subscriptionId}`,
    "An account is paying for two plans",
    `Account ${account.id} (${account.email}) already has subscription ${account.stripe_subscription_id}, and ${subscriptionId} was paid too. ` +
      "No credits were added for the second one. Cancel and refund it in Stripe.",
  );
}

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

/**
 * The plan on an invoice: from its regular subscription line for the latest period. For a plan
 * change it's the prorated charge for the new plan, and the previous plan is the credit line.
 */
async function planForInvoice(stripe: Stripe, invoice: Stripe.Invoice): Promise<Prepared> {
  if (!invoiceSubscription(invoice)) return { plan: null };
  const lines = sortedLines(invoice);
  let previousPlan: PlanId | null = null;
  const credit = lines.find((l) => l.parent?.subscription_item_details?.proration && l.amount < 0);
  if (credit) previousPlan = asPlan(await itemForPrice(stripe, linePrice(credit)));
  for (const line of lines) {
    if (line.amount < 0) continue;
    const plan = asPlan(await itemForPrice(stripe, linePrice(line)));
    if (plan) return { plan, periodEnd: line.period.end, previousPlan };
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
