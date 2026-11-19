import { existsSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { createApp } from "./app.js";
import { startBackgroundJobs } from "./jobs.js";
import { loadConfig, sessionSecret } from "./config.js";
import { Snapshot } from "./data/snapshot.js";
import { SNAPSHOT_FILES } from "./data/schema.js";
import { createPool } from "./db/pool.js";
import { log } from "./log.js";
import { createMailer } from "./mail/mailer.js";
import { createServices, type Services } from "./services.js";

const config = loadConfig();
sessionSecret(config); // Fails fast in production without SESSION_SECRET.
let snapshot: Snapshot | null = null;

async function loadSnapshot() {
  if (!existsSync(join(config.SNAPSHOT_DIR, SNAPSHOT_FILES.manifest))) {
    log.warn({ dir: config.SNAPSHOT_DIR }, "no snapshot on disk yet; data tools will answer snapshot_unavailable");
    return;
  }
  snapshot = await Snapshot.open(config.SNAPSHOT_DIR, { serveHttpArchive: config.SERVE_HTTPARCHIVE });
  log.info({ manifest: snapshot.manifest, serveHttpArchive: config.SERVE_HTTPARCHIVE }, "snapshot loaded");
}

let services: Services | null = null;
if (config.DATABASE_URL) {
  const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
  if (!stripe) log.warn("STRIPE_SECRET_KEY is not set: checkout answers billing_unavailable");
  services = createServices(config, createPool(config.DATABASE_URL), createMailer(config), stripe);
  startBackgroundJobs(services);
} else {
  log.warn("DATABASE_URL is not set: accounts and paid tools are off; free tools answer anonymously");
}

const app = createApp({ config, getSnapshot: () => snapshot, services });
app.listen(config.PORT, () => log.info({ port: config.PORT }, "listening"));
loadSnapshot().catch((err) => log.error({ err }, "snapshot failed to load"));
