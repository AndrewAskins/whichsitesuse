import { sessionSecret, type Config } from "../config.js";
import { signPayload, verifyPayload } from "../auth/tokens.js";
import { CHECKOUT_ITEMS, PLANS, TOPUP, type CheckoutItem, type PlanId } from "./plans.js";

/**
 * A checkout link on our own domain that a human opens and pays. Agents get
 * these from buy_credits and from insufficient_credits errors. Opening one
 * creates a fresh Stripe Checkout session (Stripe's own expire in 24 hours),
 * so the link stays good for a week. Anyone holding it can only pay into the
 * account; it grants nothing else.
 */
export interface CheckoutLinkPayload {
  /** Account id. */
  a: string;
  /** What to buy. */
  i: CheckoutItem;
  /** Units: top-up blocks of 1,000 credits; always 1 for a plan. */
  u: number;
  exp: number;
}

const LINK_TTL_SECONDS = 7 * 24 * 3600;

export function checkoutLink(config: Config, accountId: string, item: CheckoutItem, units = 1): string {
  const payload: CheckoutLinkPayload = {
    a: accountId,
    i: item,
    u: item === "topup" ? clampUnits(units) : 1,
    exp: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
  };
  return `${config.PUBLIC_BASE_URL}/buy/${signPayload(sessionSecret(config), payload as unknown as Record<string, unknown>)}`;
}

export function readCheckoutLink(config: Config, token: string): CheckoutLinkPayload | null {
  const p = verifyPayload<CheckoutLinkPayload>(sessionSecret(config), token);
  if (!p || typeof p.a !== "string" || !(CHECKOUT_ITEMS as readonly string[]).includes(p.i)) return null;
  return { ...p, u: p.i === "topup" ? clampUnits(p.u) : 1 };
}

export function clampUnits(units: number): number {
  return Math.min(TOPUP.maxUnits, Math.max(1, Math.floor(units || 1)));
}

/** Top-up blocks that cover a shortfall of `credits`. */
export function unitsFor(credits: number): number {
  return clampUnits(Math.ceil(credits / TOPUP.creditsPerUnit));
}

/** The smallest plan whose monthly credits cover `credits`, or the biggest plan. */
export function planFor(credits: number): PlanId {
  const plans = Object.values(PLANS);
  return (plans.find((p) => p.monthlyCredits >= credits) ?? plans.at(-1)!).id;
}
