import Stripe from "stripe";
import { createApp } from "./app.js";
import { startBackgroundJobs } from "./jobs.js";
import { loadConfig, sessionSecret } from "./config.js";
import { SnapshotHolder } from "./data/sync.js";
import { createPool } from "./db/pool.js";
import { log } from "./log.js";
import { createMailer } from "./mail/mailer.js";
import { SeoHolder } from "./seo/holder.js";
import { createServices, type Services } from "./services.js";

const config = loadConfig();
sessionSecret(config); // Fails fast in production without SESSION_SECRET.
const snapshots = new SnapshotHolder(config);
const seo = new SeoHolder(config);

let services: Services | null = null;
if (config.DATABASE_URL) {
  const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
  if (!stripe) log.warn("STRIPE_SECRET_KEY is not set: checkout answers billing_unavailable");
  services = createServices(config, createPool(config.DATABASE_URL), createMailer(config), stripe);
  startBackgroundJobs(services);
} else {
  log.warn("DATABASE_URL is not set: accounts and paid tools are off; free tools answer anonymously");
}

const app = createApp({ config, getSnapshot: () => snapshots.get(), services, getSeoPlan: () => seo.get() });
app.listen(config.PORT, () => log.info({ port: config.PORT }, "listening"));
snapshots.start().catch((err) => log.error({ err }, "snapshot failed to load"));
seo.start().catch((err) => log.error({ err }, "seo dataset failed to load"));
