import type { Account } from "./accounts.js";
import { randomToken, sha256 } from "./tokens.js";
import type { Services } from "../services.js";

const TTL_MINUTES = { verify: 24 * 60, login: 30 } as const;
export type LinkPurpose = keyof typeof TTL_MINUTES;

/** Emails a one-time sign-in link. An unverified account always gets a "verify" link. */
export async function sendMagicLink(services: Services, account: Account): Promise<void> {
  const purpose: LinkPurpose = account.email_verified_at ? "login" : "verify";
  const token = randomToken(32);
  await services.db.query(
    `INSERT INTO login_tokens (account_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [account.id, sha256(token), purpose, TTL_MINUTES[purpose]],
  );
  const url = `${services.config.PUBLIC_BASE_URL}/auth/${token}`;
  const verify = purpose === "verify";
  await services.mailer.send({
    to: account.email,
    subject: verify ? "Confirm your WhichSitesUse email" : "Your WhichSitesUse sign-in link",
    text: verify
      ? `Hi,\n\nConfirm your email to finish signing up for WhichSitesUse:\n\n${url}\n\n` +
        `The link works once and lasts 24 hours. If you didn't sign up, ignore this email.\n`
      : `Hi,\n\nHere's your link to sign in to WhichSitesUse:\n\n${url}\n\n` +
        `It works once and lasts 30 minutes. If you didn't ask for it, ignore this email.\n`,
  });
}

/** Uses a link once. Returns its account and purpose, or null if it's unknown, used or expired. */
export async function consumeMagicLink(
  services: Services,
  token: string,
): Promise<{ accountId: string; purpose: LinkPurpose } | null> {
  const { rows } = await services.db.query<{ account_id: string; purpose: LinkPurpose }>(
    `UPDATE login_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING account_id, purpose`,
    [sha256(token)],
  );
  return rows[0] ? { accountId: rows[0].account_id, purpose: rows[0].purpose } : null;
}

/** True while a link is still usable, without using it (for the confirm page). */
export async function magicLinkValid(services: Services, token: string): Promise<boolean> {
  const { rowCount } = await services.db.query(
    `SELECT 1 FROM login_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  return (rowCount ?? 0) > 0;
}
