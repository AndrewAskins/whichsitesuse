import express from "express";
import { RateLimiter } from "./abuse/rateLimit.js";
import { stripeWebhookHandler } from "./billing/webhooks.js";
import type { Config } from "./config.js";
import type { Snapshot } from "./data/snapshot.js";
import type { GateDeps } from "./http/gate.js";
import { mcpHandler } from "./http/mcp.js";
import { restRouter } from "./http/rest.js";
import { operations as allOperations } from "./operations/index.js";
import type { Operation } from "./operations/types.js";
import type { Services } from "./services.js";
import { cors, oauthApiRoutes } from "./web/oauth.js";
import { webRouter } from "./web/router.js";

export const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  getSnapshot: () => Snapshot | null;
  /** App database services; without them only the free tools answer, anonymously. */
  services?: Services | null;
  limiter?: RateLimiter;
  /** Tests swap in extra operations; the app serves the real list. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operations?: Operation<any, any>[];
}

export function createApp({
  config,
  getSnapshot,
  services = null,
  limiter = new RateLimiter(),
  operations = allOperations,
}: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  // Render puts one proxy in front of the service; req.ip is then the caller's address.
  app.set("trust proxy", 1);

  // Stripe signs the raw body, so this route must come before express.json().
  if (services) app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhookHandler(services));

  app.use(express.json({ limit: "256kb" }));

  const deps: GateDeps = { config, getSnapshot, services, limiter };

  app.get("/health", (_req, res) => {
    const snapshot = getSnapshot();
    res.json({
      ok: true,
      version: VERSION,
      snapshot: snapshot ? { crawl_date: snapshot.manifest.crawl_date, counts: snapshot.manifest.counts } : null,
      serving_httparchive: config.SERVE_HTTPARCHIVE,
      accounts: services !== null,
      billing: services?.stripe != null,
    });
  });

  app.use("/v1", restRouter(operations, deps));

  if (services) app.use(oauthApiRoutes(services));

  const mcp = mcpHandler(operations, deps, VERSION);
  app.use("/mcp", cors);
  app.post("/mcp", mcp);
  // Stateless server: no SSE stream to resume and no session to delete.
  app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
  app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());

  if (services) app.use(webRouter(services));

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } }));
  return app;
}
