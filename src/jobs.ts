import { emailListsStale, refreshEmailLists } from "./auth/emailLists.js";
import { log } from "./log.js";
import type { Services } from "./services.js";

const HOUR = 3600_000;

/**
 * In-process timers instead of extra cron services (free, and v1 runs one
 * instance): expire old credit lots hourly, and refresh the disposable and
 * free-mail domain lists when they are more than a week old.
 */
export function startBackgroundJobs(services: Services): void {
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const run = () => fn().catch((err) => log.error({ err, job: name }, "background job failed"));
    setTimeout(run, 30_000).unref();
    setInterval(run, ms).unref();
  };
  every(HOUR, "expire-credits", () => services.ledger.sweepExpired());
  every(6 * HOUR, "email-lists", async () => {
    if (await emailListsStale(services)) log.info({ counts: await refreshEmailLists(services) }, "email domain lists refreshed");
  });
}
