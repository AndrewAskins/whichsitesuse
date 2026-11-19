import { z } from "zod";
import { checkoutLink, planFor, unitsFor } from "../billing/checkoutLinks.js";
import { CREDIT_COSTS, PLANS, TOPUP, formatUsd, itemLabel, itemPriceCents } from "../billing/plans.js";
import type { Config } from "../config.js";
import { OperationError } from "./types.js";

export { CREDIT_COSTS };

/** Spread into a paid operation's input; the gate caps the call's spend to it. */
export const maxCreditsInput = {
  max_credits: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Most credits this call may spend. The call returns fewer results rather than spend more."),
};

/** An insufficient_credits error that tells an agent exactly what to do next. */
export function insufficientCredits(
  config: Config,
  accountId: string | null,
  needed: number,
  available: number,
  reason: "balance" | "max_credits" | "key_cap" = "balance",
): OperationError {
  const short = Math.max(0, needed - available);
  const message =
    reason === "max_credits"
      ? `This call costs ${needed} credits but max_credits allows ${available}. Raise max_credits or narrow the request.`
      : reason === "key_cap"
        ? `This call costs ${needed} credits but this API key's monthly cap leaves ${available}. The account owner can raise the cap in the dashboard.`
        : `This call costs ${needed} credits and the balance is ${available}. Ask the person you're working for to buy credits: ` +
          `open the checkout link below, or call buy_credits for another option.`;
  const details: Record<string, unknown> = { credits_needed: needed, credits_available: available, credits_short: short, reason };
  if (accountId && reason === "balance") {
    const units = unitsFor(short);
    const plan = planFor(needed);
    details.options = [
      {
        item: "topup",
        units,
        label: itemLabel("topup", units),
        price: formatUsd(itemPriceCents("topup", units)),
        checkout_url: checkoutLink(config, accountId, "topup", units),
      },
      {
        item: plan,
        label: itemLabel(plan),
        price: `${formatUsd(PLANS[plan].priceCents)}/month`,
        checkout_url: checkoutLink(config, accountId, plan),
      },
    ];
    details.next_step = "A human opens a checkout_url and pays; the credits appear on the next get_balance.";
  }
  return new OperationError("insufficient_credits", message, details);
}

export const PRICE_SUMMARY =
  `Credits: 1 per site in a list, ${CREDIT_COSTS.domainLookup} per domain lookup; counts and technology search are free. ` +
  `Plans: ${Object.values(PLANS)
    .map((p) => `${p.name} ${formatUsd(p.priceCents)}/mo for ${p.monthlyCredits.toLocaleString("en-US")}`)
    .join(", ")}. Top-ups ${formatUsd(TOPUP.priceCentsPerUnit)} per ${TOPUP.creditsPerUnit.toLocaleString("en-US")}.`;
