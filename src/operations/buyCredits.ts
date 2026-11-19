import { z } from "zod";
import { checkoutLink } from "../billing/checkoutLinks.js";
import { CHECKOUT_ITEMS, PLANS, TOPUP, formatUsd, itemLabel, itemPriceCents } from "../billing/plans.js";
import { OperationError, type Operation } from "./types.js";

const input = z.object({
  item: z
    .enum(CHECKOUT_ITEMS)
    .describe(
      `What to buy: "topup" (${formatUsd(TOPUP.priceCentsPerUnit)} per ${TOPUP.creditsPerUnit.toLocaleString("en-US")} credits, ` +
        `lasts 12 months) or a monthly plan: ${Object.values(PLANS)
          .map((p) => `"${p.id}" (${formatUsd(p.priceCents)}/mo, ${p.monthlyCredits.toLocaleString("en-US")} credits)`)
          .join(", ")}.`,
    ),
  units: z.coerce
    .number()
    .int()
    .min(1)
    .max(TOPUP.maxUnits)
    .default(1)
    .describe(`Top-ups only: how many blocks of ${TOPUP.creditsPerUnit.toLocaleString("en-US")} credits.`),
});

export interface CheckoutResult {
  checkout_url: string;
  item: string;
  label: string;
  price: string;
  credits: number;
  next_step: string;
}

export const buyCredits: Operation<typeof input.shape, CheckoutResult> = {
  name: "buy_credits",
  title: "Buy credits",
  description:
    "Creates a checkout link for a top-up or a monthly plan. You can't pay yourself: give the link to the " +
    "person you're working for, who opens it and pays by card. Credits appear on the next get_balance " +
    "once payment clears. Free to call; nothing is charged until the human pays.",
  rest: { method: "post", path: "/checkout" },
  pricing: "account",
  input,
  async run({ item, units }, ctx) {
    if (!ctx.caller) throw new OperationError("unauthorized", "buy_credits needs an API key.");
    const n = item === "topup" ? units : 1;
    return {
      data: {
        checkout_url: checkoutLink(ctx.config, ctx.caller.account.id, item, n),
        item,
        label: itemLabel(item, n),
        price: item === "topup" ? formatUsd(itemPriceCents(item, n)) : `${formatUsd(itemPriceCents(item))}/month`,
        credits: item === "topup" ? n * TOPUP.creditsPerUnit : PLANS[item].monthlyCredits,
        next_step:
          "Give checkout_url to the person you're working for. It opens a secure Stripe checkout and stays valid for 7 days.",
      },
      credits_used: 0,
    };
  },
};
