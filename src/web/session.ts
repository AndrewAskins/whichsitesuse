import type { NextFunction, Request, Response } from "express";
import type { Account } from "../auth/accounts.js";
import { hmac, randomToken, safeEqual, sha256 } from "../auth/tokens.js";
import { sessionSecret } from "../config.js";
import type { Services } from "../services.js";

export const SESSION_COOKIE = "wsu_session";
const SESSION_DAYS = 30;

export interface WebLocals {
  account: Account | null;
  sessionId: string | null;
  /** CSRF token for this session; forms send it back as `csrf`. */
  csrf: string;
}

/** res.locals, typed. */
export function locals(res: Response): WebLocals {
  return res.locals as WebLocals;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieFlags(services: Services, maxAgeSeconds: number): string {
  const secure = services.config.PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Starts a signed-in session and sets its cookie. */
export async function startSession(services: Services, res: Response, accountId: string): Promise<void> {
  const token = randomToken(32);
  await services.db.query(
    `INSERT INTO web_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [accountId, sha256(token), SESSION_DAYS],
  );
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieFlags(services, SESSION_DAYS * 86400)}`);
}

export async function endSession(services: Services, req: Request, res: Response): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await services.db.query("DELETE FROM web_sessions WHERE token_hash = $1", [sha256(token)]);
  res.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags(services, 0)}`);
}

/** Loads the signed-in account (if any) into res.locals and sets the CSRF token. */
export function sessionMiddleware(services: Services) {
  const secret = sessionSecret(services.config);
  return async (req: Request, res: Response, next: NextFunction) => {
    const l = locals(res);
    l.account = null;
    l.sessionId = null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const { rows } = await services.db.query<{ id: string; account_id: string }>(
        `UPDATE web_sessions SET last_seen_at = now()
          WHERE token_hash = $1 AND expires_at > now() RETURNING id, account_id`,
        [sha256(token)],
      );
      if (rows[0]) {
        l.sessionId = rows[0].id;
        l.account = await services.accounts.byId(rows[0].account_id);
      }
    }
    // Signed-out forms (sign-up, sign-in) still get a token tied to a per-browser cookie.
    l.csrf = hmac(secret, `csrf:${l.sessionId ?? anonCsrfSeed(req, res, services)}`);
    next();
  };
}

const ANON_COOKIE = "wsu_anon";
function anonCsrfSeed(req: Request, res: Response, services: Services): string {
  let seed = parseCookies(req.headers.cookie)[ANON_COOKIE];
  if (!seed) {
    seed = randomToken(16);
    res.append("Set-Cookie", `${ANON_COOKIE}=${seed}; ${cookieFlags(services, 86400)}`);
  }
  return seed;
}

/** Rejects a POST whose `csrf` field doesn't match the session's token. */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const sent = typeof req.body?.csrf === "string" ? req.body.csrf : "";
  if (!sent || !safeEqual(sent, locals(res).csrf)) {
    res.status(403).send("This form expired. Go back, reload the page and try again.");
    return;
  }
  next();
}

export function requireAccount(req: Request, res: Response, next: NextFunction) {
  if (!locals(res).account) {
    res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const account = locals(res).account;
  if (!account) return requireAccount(req, res, next);
  if (!account.is_admin) {
    res.status(404).send("Not found");
    return;
  }
  next();
}
