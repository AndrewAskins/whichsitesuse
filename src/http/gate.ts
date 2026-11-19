import type { z } from "zod";
import { isTrial } from "../auth/accounts.js";
import { InsufficientCreditsError } from "../billing/ledger.js";
import { RATE_LIMITS, TRIAL_CAPS } from "../billing/plans.js";
import type { Config } from "../config.js";
import type { Snapshot } from "../data/snapshot.js";
import { withTransaction } from "../db/pool.js";
import { log } from "../log.js";
import { RateLimiter } from "../abuse/rateLimit.js";
import { insufficientCredits } from "../operations/billing.js";
import { envelope, type Envelope } from "../operations/envelope.js";
import {
  OperationError,
  type Billing,
  type Caller,
  type Operation,
  type OperationContext,
} from "../operations/types.js";
import type { Services } from "../services.js";

export interface GateDeps {
  config: Config;
  getSnapshot: () => Snapshot | null;
  services: Services | null;
  limiter: RateLimiter;
}

export interface CallInfo {
  channel: "mcp" | "rest";
  /** The Authorization header (or x-api-key), if any. */
  credential: string | undefined;
  ip: string;
  /** Set when the transport already authenticated the credential (MCP does, to answer 401 itself). */
  caller?: Caller;
}

/** Reads "Bearer wsu_live_..." or a bare key. */
export function credentialFrom(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (value) return value.replace(/^Bearer\s+/i, "").trim() || undefined;
  const key = headers["x-api-key"];
  return (Array.isArray(key) ? key[0] : key)?.trim() || undefined;
}

/**
 * Every MCP and REST call goes through here: identify the caller, rate-limit,
 * work out what the call may spend, run the operation, charge what it used
 * (with a usage event) and wrap the result in the shared envelope.
 */
export async function runOperation(
  op: Operation<z.ZodRawShape, unknown>,
  input: Record<string, unknown>,
  call: CallInfo,
  deps: GateDeps,
): Promise<Envelope<unknown>> {
  const { config, services } = deps;
  const pricing = op.pricing ?? "free";
  const caller = call.caller ?? (await identify(call.credential, services));

  if (caller) {
    if (caller.account.status === "suspended") {
      throw new OperationError("account_suspended", "This account is suspended. Reply to any WhichSitesUse email to sort it out.");
    }
    const limit = isTrial(caller.account) ? RATE_LIMITS.trialPerMinute : RATE_LIMITS.paidPerMinute;
    rateLimit(deps.limiter, `acct:${caller.account.id}`, limit);
  } else {
    if (pricing !== "free") {
      throw new OperationError(
        "unauthorized",
        `${op.name} needs a WhichSitesUse API key. Sign up at ${config.PUBLIC_BASE_URL}/signup ` +
          "(verified work emails get free credits), create a key on the account page, and send it as " +
          '"Authorization: Bearer <key>".',
        { signup_url: `${config.PUBLIC_BASE_URL}/signup` },
      );
    }
    rateLimit(deps.limiter, `ip:${call.ip}`, RATE_LIMITS.anonymousPerMinute);
  }

  const billing = caller && services ? await billingFor(caller, input, services, config) : noBilling(config);
  const ctx: OperationContext = { config, snapshot: deps.getSnapshot(), caller, billing, services };

  let result;
  try {
    result = await op.run(input, ctx);
  } catch (err) {
    if (caller && services) void recordUsage(services, caller, op.name, call.channel, 0, input, err);
    throw err;
  }

  let remaining: number | null = caller ? billing.balance : null;
  if (result.credits_used > 0) {
    if (!caller || !services) throw new Error(`${op.name} spent credits without a signed-in caller`);
    billing.require(result.credits_used);
    remaining = await charge(services, caller, op.name, call.channel, result.credits_used, input, config);
  } else if (caller && services) {
    void recordUsage(services, caller, op.name, call.channel, 0, input, null);
  }
  return envelope(result, ctx, remaining);
}

async function identify(credential: string | undefined, services: Services | null): Promise<Caller | null> {
  if (!credential) return null;
  if (!services) {
    throw new OperationError("billing_unavailable", "Accounts aren't available on this server right now.");
  }
  const found = await services.accounts.authenticate(credential);
  if (!found) {
    throw new OperationError(
      "unauthorized",
      "That API key or token isn't valid, has expired or has been revoked. Create a new key on the account page, or reconnect the app.",
    );
  }
  return found;
}

function rateLimit(limiter: RateLimiter, key: string, limit: number) {
  const wait = limiter.hit(key, limit);
  if (wait > 0) {
    throw new OperationError("rate_limited", `Too many calls. Try again in ${wait} seconds.`, {
      retry_after_seconds: wait,
      limit_per_minute: limit,
    });
  }
}

type GateBilling = Billing & { balance: number };

function noBilling(config: Config): GateBilling {
  return {
    available: 0,
    balance: 0,
    maxResults: TRIAL_CAPS.maxResultsPerCall,
    canExport: false,
    require(credits: number) {
      if (credits > 0) throw insufficientCredits(config, null, credits, 0);
    },
  };
}

async function billingFor(
  caller: Caller,
  input: Record<string, unknown>,
  services: Services,
  config: Config,
): Promise<GateBilling> {
  const balance = (await services.ledger.balance(caller.account.id)).total;
  const cap = caller.key.monthly_credit_cap;
  const capLeft = cap === null ? Infinity : Math.max(0, cap - (await services.accounts.keyCreditsThisMonth(caller.key.id)));
  const maxCredits = typeof input.max_credits === "number" ? input.max_credits : Infinity;
  const available = Math.min(balance, capLeft, maxCredits);
  const trial = isTrial(caller.account);
  return {
    available,
    balance,
    maxResults: trial ? TRIAL_CAPS.maxResultsPerCall : null,
    canExport: !trial,
    require(credits: number) {
      if (credits <= available) return;
      // Name the tightest limit, so the agent knows whether to buy, raise max_credits or ask about the cap.
      const reason = maxCredits <= Math.min(balance, capLeft) ? "max_credits" : capLeft < balance ? "key_cap" : "balance";
      throw insufficientCredits(config, caller.account.id, credits, available, reason);
    },
  };
}

/** Records the usage event and spends its credits in one transaction. Returns the balance left. */
async function charge(
  services: Services,
  caller: Caller,
  operation: string,
  channel: CallInfo["channel"],
  credits: number,
  input: Record<string, unknown>,
  config: Config,
): Promise<number> {
  try {
    return await withTransaction(services.db, async (c) => {
      // The cap was checked before the call ran; parallel calls on one key could all pass that
      // check, so it is checked again here with the key locked, before anything is spent.
      const key = await c.query<{ cap: number | null }>(
        `SELECT monthly_credit_cap AS cap FROM api_keys WHERE id = $1 FOR UPDATE`,
        [caller.key.id],
      );
      const cap = key.rows[0]?.cap ?? null;
      if (cap !== null) {
        const used = await c.query<{ used: string | null }>(
          `SELECT sum(credits)::text AS used FROM usage_events
            WHERE api_key_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [caller.key.id],
        );
        const left = Math.max(0, cap - Number(used.rows[0]?.used ?? 0));
        if (credits > left) throw insufficientCredits(config, caller.account.id, credits, left, "key_cap");
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO usage_events (account_id, api_key_id, operation, channel, credits, status, params)
         VALUES ($1, $2, $3, $4, $5, 'ok', $6) RETURNING id`,
        [caller.account.id, caller.key.id, operation, channel, credits, JSON.stringify(input)],
      );
      const balance = await services.ledger.spend(caller.account.id, credits, `usage:${rows[0]!.id}`, c);
      return balance.total;
    });
  } catch (err) {
    // The balance moved between the check and the charge (a parallel call spent it).
    if (err instanceof InsufficientCreditsError) {
      throw insufficientCredits(config, caller.account.id, err.needed, err.available);
    }
    throw err;
  }
}

async function recordUsage(
  services: Services,
  caller: Caller,
  operation: string,
  channel: CallInfo["channel"],
  credits: number,
  input: Record<string, unknown>,
  err: unknown,
) {
  const code = err ? (err instanceof OperationError ? err.code : "internal") : null;
  await services.db
    .query(
      `INSERT INTO usage_events (account_id, api_key_id, operation, channel, credits, status, error_code, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [caller.account.id, caller.key.id, operation, channel, credits, code ? "error" : "ok", code, JSON.stringify(input)],
    )
    .catch((e: unknown) => log.warn({ err: e }, "usage event not recorded"));
}
