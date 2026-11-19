import { Router, type RequestHandler } from "express";
import { RateLimiter } from "../abuse/rateLimit.js";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.js";
import type { Config } from "../config.js";
import type { Snapshot } from "../data/snapshot.js";
import { envelope } from "../operations/envelope.js";
import { lookupDomain } from "../operations/lookupDomain.js";
import { OperationError, type Billing } from "../operations/types.js";
import type { Services } from "../services.js";
import { sendError } from "./rest.js";

/**
 * The free domain lookup behind the homepage box. Same answer as lookup_domain,
 * free and keyless, limited per IP so the paid tool stays the way to look up
 * many domains. When Turnstile keys are set, each call needs a fresh token.
 */

/** Our own sites, the only browser origins allowed to call the public routes. */
export const PUBLIC_ORIGINS = [
  "https://whichsitesuse.com",
  "https://www.whichsitesuse.com",
  "https://whichsitesuse-web.onrender.com",
];

export const PUBLIC_LIMITS = { perMinute: 10, perDay: 100 } as const;
export const TURNSTILE_HEADER = "x-turnstile-token";

export function publicCors(origins: readonly string[] = PUBLIC_ORIGINS): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary("Origin");
    if (origin && origins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.set("Access-Control-Allow-Headers", `Content-Type, ${TURNSTILE_HEADER}`);
      res.set("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Nothing is charged, so the lookup's own credit check always passes. */
const freeBilling: Billing = { available: Number.POSITIVE_INFINITY, maxResults: null, canExport: false, require() {} };

export interface PublicDeps {
  config: Config;
  getSnapshot: () => Snapshot | null;
  services: Services | null;
  now?: () => number;
}

export function publicRouter({ config, getSnapshot, services, now = Date.now }: PublicDeps): Router {
  const perMinute = new RateLimiter(60_000, now);
  const perDay = new RateLimiter(86_400_000, now);
  const router = Router();
  router.use(publicCors());

  router.get("/domains/:domain", async (req, res) => {
    try {
      const ip = req.ip ?? "unknown";
      for (const [limiter, limit, label] of [
        [perMinute, PUBLIC_LIMITS.perMinute, "a minute"],
        [perDay, PUBLIC_LIMITS.perDay, "a day"],
      ] as const) {
        const wait = limiter.hit(`public:${ip}`, limit);
        if (wait > 0) {
          throw new OperationError(
            "rate_limited",
            `The free lookup allows ${limit} domains ${label}. Try again in ${wait} seconds, or use the API for more.`,
            { retry_after_seconds: wait },
          );
        }
      }
      if (turnstileEnabled(config)) {
        const token = req.get(TURNSTILE_HEADER);
        if (!(await verifyTurnstile(config, token, ip))) {
          throw new OperationError("unauthorized", "Complete the bot check, then look the domain up again.");
        }
      }
      const snapshot = getSnapshot();
      const ctx = { config, snapshot, caller: null, billing: freeBilling, services };
      const result = await lookupDomain.run(lookupDomain.input.parse({ domain: req.params.domain }), ctx);
      res.json(envelope({ data: result.data, credits_used: 0 }, ctx));
    } catch (err) {
      sendError(res, err, "public_lookup_domain");
    }
  });

  return router;
}
