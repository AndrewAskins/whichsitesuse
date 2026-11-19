import { describe, expect, it } from "vitest";
import { planFor, unitsFor } from "../src/billing/checkoutLinks.js";
import { CREDIT_COSTS, FREE_GRANT, PLANS, TOPUP, formatUsd, itemLabel } from "../src/billing/plans.js";

// The prices Andrew approved on Nov 19, 2026. A change here is a pricing decision, not a refactor.
describe("pricing", () => {
  it("has four monthly plans", () => {
    expect(Object.values(PLANS).map((p) => [p.id, p.priceCents, p.monthlyCredits])).toEqual([
      ["starter", 4900, 15_000],
      ["growth", 14900, 60_000],
      ["pro", 39900, 200_000],
      ["scale", 99900, 750_000],
    ]);
  });

  it("sells top-ups at $15 per 1,000 credits", () => {
    expect(TOPUP).toMatchObject({ creditsPerUnit: 1000, priceCentsPerUnit: 1500 });
    expect(itemLabel("topup", 2)).toBe("2,000 credits (top-up)");
    expect(formatUsd(2 * TOPUP.priceCentsPerUnit)).toBe("$30");
  });

  it("keeps per-call costs and the free grant as they were", () => {
    expect(CREDIT_COSTS).toEqual({ site: 1, domainLookup: 2, history: 3, liveCheck: 10 });
    expect(FREE_GRANT.credits).toBe(250);
  });

  it("gives each price its own Stripe lookup key", () => {
    const keys = [...Object.values(PLANS).map((p) => p.lookupKey), TOPUP.lookupKey];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("suggests the smallest plan that covers a shortfall", () => {
    expect(planFor(1)).toBe("starter");
    expect(planFor(15_001)).toBe("growth");
    expect(planFor(500_000)).toBe("scale");
    expect(planFor(10_000_000)).toBe("scale");
    expect(unitsFor(1500)).toBe(2);
  });
});
