import { z } from "zod";
import { isTrial } from "../auth/accounts.js";
import { PLANS, TRIAL_CAPS } from "../billing/plans.js";
import { PRICE_SUMMARY } from "./billing.js";
import { OperationError, type Operation } from "./types.js";

const input = z.object({});

export interface BalanceResult {
  credits: { total: number; plan: number; topup: number; free: number };
  plan: { id: string; name: string; credits_per_month: number; renews_at: string | null } | null;
  /** Accounts that have never paid are on the trial caps. */
  trial: { max_results_per_call: number; calls_per_minute: number; csv_export: false } | null;
  key: { name: string; monthly_credit_cap: number | null; credits_used_this_month: number };
  buy_credits_url: string;
  prices: string;
}

export const getBalance: Operation<typeof input.shape, BalanceResult> = {
  name: "get_balance",
  title: "Get balance",
  description:
    "Credits left (plan, top-up and free), the plan and its renewal date, this API key's monthly cap and " +
    "what it has used, and where to buy more. Free. Call it before a large search, or after a checkout to see " +
    "whether the purchase has landed.",
  rest: { method: "get", path: "/balance" },
  pricing: "account",
  input,
  async run(_input, ctx) {
    const { caller, services } = ctx;
    if (!caller || !services) throw new OperationError("unauthorized", "get_balance needs an API key.");
    const { account, key } = caller;
    const [balance, used] = await Promise.all([
      services.ledger.balance(account.id),
      services.accounts.keyCreditsThisMonth(key.id),
    ]);
    const plan = account.plan === "none" ? null : PLANS[account.plan];
    return {
      data: {
        credits: { total: balance.total, plan: balance.plan, topup: balance.topup, free: balance.trial },
        plan: plan
          ? {
              id: plan.id,
              name: plan.name,
              credits_per_month: plan.monthlyCredits,
              renews_at: account.plan_renews_at ? new Date(account.plan_renews_at).toISOString() : null,
            }
          : null,
        trial: isTrial(account)
          ? { max_results_per_call: TRIAL_CAPS.maxResultsPerCall, calls_per_minute: TRIAL_CAPS.callsPerMinute, csv_export: false }
          : null,
        key: { name: key.name, monthly_credit_cap: key.monthly_credit_cap, credits_used_this_month: used },
        buy_credits_url: `${ctx.config.PUBLIC_BASE_URL}/account`,
        prices: PRICE_SUMMARY,
      },
      credits_used: 0,
    };
  },
};
