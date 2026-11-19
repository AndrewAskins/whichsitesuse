import { Router, type Response } from "express";
import type { Account } from "../auth/accounts.js";
import { clampUnits, readCheckoutLink } from "../billing/checkoutLinks.js";
import { CHECKOUT_ITEMS, type CheckoutItem } from "../billing/plans.js";
import { checkoutUrl, hasActiveSubscription, portalUrl } from "../billing/stripe.js";
import { log } from "../log.js";
import { OperationError } from "../operations/types.js";
import type { Services } from "../services.js";
import { html, page, type Html } from "./layout.js";
import { locals, requireAccount, requireCsrf } from "./session.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checkout: the signed /buy links agents hand out, and the buy and billing buttons on /account. */
export function buyRoutes(services: Services): Router {
  const router = Router();

  // No sign-in: the person paying may not be the account owner, and the link can only pay into its account.
  router.get("/buy/:token", async (req, res) => {
    const link = readCheckoutLink(services.config, req.params.token);
    const account = link && UUID.test(link.a) ? await services.accounts.byId(link.a) : null;
    if (!link || !account) {
      return message(res, 400, "Link expired", html`<p>This checkout link has expired or isn't valid.</p>
<p>Ask your agent for a new one (it can call <code>buy_credits</code>), or <a href="/login">sign in</a> and buy from your account page.</p>`);
    }
    if (account.status === "suspended") {
      return message(res, 403, "Account suspended", html`<p>This account is suspended, so it can't take payments.</p>`);
    }
    // A plan change goes through the Billing Portal, which shows invoices and payment
    // methods; that needs the owner signed in, not just someone holding this link.
    if (link.i !== "topup" && hasActiveSubscription(account)) {
      return message(res, 409, "Already on a plan", html`<p>This account already has a plan. To change it, the account owner can
<a href="/account/billing">sign in and open billing</a>. Top-ups can be bought any time.</p>`);
    }
    await redirectToCheckout(services, res, account, link.i, link.u);
  });

  router.post("/account/buy", requireAccount, requireCsrf, async (req, res) => {
    const item = String(req.body?.item ?? "");
    if (!(CHECKOUT_ITEMS as readonly string[]).includes(item)) {
      return message(res, 400, "Unknown item", html`<p>Pick a plan or a top-up from <a href="/account">your account page</a>.</p>`);
    }
    await redirectToCheckout(services, res, locals(res).account!, item as CheckoutItem, clampUnits(Number(req.body?.units)));
  });

  router.get("/account/billing", requireAccount, async (_req, res) => {
    const account = locals(res).account!;
    if (!account.stripe_customer_id) return res.redirect(303, "/account");
    try {
      res.redirect(303, await portalUrl(services, account));
    } catch (err) {
      stripeFailed(res, err);
    }
  });

  return router;
}

async function redirectToCheckout(services: Services, res: Response, account: Account, item: CheckoutItem, units: number) {
  try {
    res.redirect(303, await checkoutUrl(services, account, item, units));
  } catch (err) {
    stripeFailed(res, err);
  }
}

function stripeFailed(res: Response, err: unknown) {
  if (err instanceof OperationError && err.code === "billing_unavailable") {
    return message(res, 503, "Billing unavailable", html`<p>Payments aren't switched on yet. Try again later.</p>`);
  }
  log.error({ err }, "Stripe checkout failed");
  message(res, 502, "Checkout unavailable", html`<p>We couldn't reach our payment provider. Try again in a minute.</p>`);
}

function message(res: Response, status: number, title: string, body: Html) {
  const account = locals(res).account;
  res.status(status).type("html").send(page({ title, body: html`<h1>${title}</h1>${body}`, signedIn: !!account, isAdmin: account?.is_admin }));
}
