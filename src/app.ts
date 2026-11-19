import express from "express";
import type { Config } from "./config.js";
import type { Snapshot } from "./data/snapshot.js";
import { mcpHandler } from "./http/mcp.js";
import { restRouter } from "./http/rest.js";
import { operations } from "./operations/index.js";
import type { OperationContext } from "./operations/types.js";

export const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  getSnapshot: () => Snapshot | null;
}

export function createApp({ config, getSnapshot }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const getContext = (): OperationContext => ({ config, snapshot: getSnapshot() });

  app.get("/health", (_req, res) => {
    const snapshot = getSnapshot();
    res.json({
      ok: true,
      version: VERSION,
      snapshot: snapshot ? { crawl_date: snapshot.manifest.crawl_date, counts: snapshot.manifest.counts } : null,
      serving_httparchive: config.SERVE_HTTPARCHIVE,
    });
  });

  app.use("/v1", restRouter(operations, getContext));

  const mcp = mcpHandler(operations, getContext, VERSION);
  app.post("/mcp", mcp);
  // Stateless server: no SSE stream to resume and no session to delete.
  app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
  app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } }));
  return app;
}
