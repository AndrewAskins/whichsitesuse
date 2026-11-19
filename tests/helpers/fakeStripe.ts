import Stripe from "stripe";

/** The webhook secret the fake signs with; tests put it in STRIPE_WEBHOOK_SECRET. */
export const WEBHOOK_SECRET = "whsec_test_fake";

interface FakePrice {
  id: string;
  lookup_key: string | null;
  unit_amount: number | null;
  active: boolean;
}

/**
 * A hand-written stand-in for the Stripe API calls billing makes, recording
 * each call. Webhook signing uses a real client's `webhooks`, which works offline.
 */
export function fakeStripe(opts: { prices?: FakePrice[] } = {}) {
  const real = new Stripe("sk_test_fake");
  const prices: FakePrice[] = [...(opts.prices ?? [])];
  const calls = {
    pricesList: [] as Record<string, unknown>[],
    pricesCreate: [] as Record<string, unknown>[],
    customersCreate: [] as { params: Record<string, unknown>; options: unknown }[],
    checkoutCreate: [] as Record<string, unknown>[],
    portalCreate: [] as Record<string, unknown>[],
  };
  let n = 0;
  const api = {
    webhooks: real.webhooks,
    prices: {
      async list(params: { lookup_keys?: string[]; active?: boolean }) {
        calls.pricesList.push(params);
        return { data: prices.filter((p) => (!params.active || p.active) && (!params.lookup_keys || params.lookup_keys.includes(p.lookup_key ?? ""))) };
      },
      async create(params: { lookup_key?: string; unit_amount?: number }) {
        calls.pricesCreate.push(params);
        const price = { id: `price_fake_${++n}`, lookup_key: params.lookup_key ?? null, unit_amount: params.unit_amount ?? null, active: true };
        prices.push(price);
        return price;
      },
    },
    customers: {
      async create(params: Record<string, unknown>, options?: unknown) {
        calls.customersCreate.push({ params, options });
        return { id: `cus_fake_${++n}` };
      },
    },
    checkout: {
      sessions: {
        async create(params: Record<string, unknown>) {
          calls.checkoutCreate.push(params);
          const id = `cs_fake_${++n}`;
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params: Record<string, unknown>) {
          calls.portalCreate.push(params);
          const id = `bps_fake_${++n}`;
          return { id, url: `https://billing.stripe.test/${id}` };
        },
      },
    },
  };
  return { stripe: api as unknown as Stripe, calls, prices };
}

/** A Stripe-Signature header for `payload`, as Stripe would send it. */
export function signWebhook(payload: string, secret = WEBHOOK_SECRET): string {
  return new Stripe("sk_test_fake").webhooks.generateTestHeaderString({ payload, secret });
}
