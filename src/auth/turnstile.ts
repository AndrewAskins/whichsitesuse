import type { Config } from "../config.js";
import { log } from "../log.js";

export function turnstileEnabled(config: Config): boolean {
  return Boolean(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY);
}

let warned = false;

/**
 * Checks a Cloudflare Turnstile token. Without keys the check is skipped (and
 * production logs a warning once), so sign-up works before Turnstile is set up.
 */
export async function verifyTurnstile(
  config: Config,
  token: string | undefined,
  ip: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!turnstileEnabled(config)) {
    if (config.NODE_ENV === "production" && !warned) {
      warned = true;
      log.warn("Turnstile keys are not set: sign-up has no bot check");
    }
    return true;
  }
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY!, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch (err) {
    log.warn({ err }, "Turnstile check failed to run");
    return false;
  }
}
