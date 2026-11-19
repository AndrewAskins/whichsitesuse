/**
 * Prices, plans, credit costs and trial caps. This file is the one place the
 * numbers live (spec: "WhichSitesUse credits", "Plans and top-ups", "Free-credit
 * abuse controls"); everything else reads them from here.
 */

/** Credits each paid action costs. Counts, technology search, balance and "not covered" are free. */
export const CREDIT_COSTS = {
  /** Each site returned by search_sites. */
  site: 1,
  /** lookup_domain: one domain's full stack. */
  domainLookup: 2,
  /** get_history: one domain or one technology (v1.1). */
  history: 3,
  /** detect_live: a fresh crawl of one domain (v1.1). */
  liveCheck: 10,
} as const;

export type PlanId = "starter" | "growth" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in US cents. */
  priceCents: number;
  /** Credits added each billing month; unspent plan credits reset at renewal. */
  monthlyCredits: number;
  /** Stripe price lookup key, so prices are found (or created) by name, not by id. */
  lookupKey: string;
}

export const PLANS: Record<PlanId, Plan> = {
  starter: { id: "starter", name: "Starter", priceCents: 1900, monthlyCredits: 5_000, lookupKey: "wsu_starter_monthly_v1" },
  growth: { id: "growth", name: "Growth", priceCents: 4900, monthlyCredits: 20_000, lookupKey: "wsu_growth_monthly_v1" },
  pro: { id: "pro", name: "Pro", priceCents: 14900, monthlyCredits: 100_000, lookupKey: "wsu_pro_monthly_v1" },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** Top-ups: $10 per 1,000 credits, anyone can buy, they last 12 months. */
export const TOPUP = {
  name: "Top-up",
  creditsPerUnit: 1_000,
  priceCentsPerUnit: 1000,
  maxUnits: 100,
  validMonths: 12,
  lookupKey: "wsu_topup_1000_v1",
} as const;

export type CheckoutItem = PlanId | "topup";
export const CHECKOUT_ITEMS = [...PLAN_IDS, "topup"] as const;

/** The one-time free grant and the caps on accounts that have never paid. */
export const FREE_GRANT = {
  credits: 250,
} as const;

export const TRIAL_CAPS = {
  /** Most results one call may return while an account has never paid. */
  maxResultsPerCall: 100,
  callsPerMinute: 30,
  canExport: false,
} as const;

/** Calls per minute. Anonymous calls (free tools only) are limited per IP. */
export const RATE_LIMITS = {
  anonymousPerMinute: 30,
  trialPerMinute: TRIAL_CAPS.callsPerMinute,
  paidPerMinute: 300,
} as const;

/** Network and device signals that withhold the free grant until a payment. */
export const GRANT_SIGNALS = {
  /** More than this many grants from one /24 (or /48) in the window withholds the next one. */
  maxGrantsPerNetwork: 2,
  networkWindowDays: 7,
} as const;

export function itemLabel(item: CheckoutItem, units = 1): string {
  if (item === "topup") return `${(units * TOPUP.creditsPerUnit).toLocaleString("en-US")} credits (top-up)`;
  const plan = PLANS[item];
  return `${plan.name} plan, ${plan.monthlyCredits.toLocaleString("en-US")} credits a month`;
}

export function itemPriceCents(item: CheckoutItem, units = 1): number {
  return item === "topup" ? units * TOPUP.priceCentsPerUnit : PLANS[item].priceCents;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
