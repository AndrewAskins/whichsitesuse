import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import type { Services } from "../services.js";
import { OAUTH_ACCESS_PREFIX } from "./accounts.js";
import { isMetadataClientId, resolveMetadataClient } from "./cimd.js";
import { randomToken, safeEqual, sha256 } from "./tokens.js";

/**
 * OAuth 2.1 for MCP clients, as the MCP authorization spec describes it:
 * protected-resource and authorization-server metadata, dynamic client
 * registration, client ID metadata documents (cimd.ts), authorization code
 * with PKCE (S256 only), rotating refresh tokens. An approved connection is stored as an api_keys row, so caps, usage,
 * revocation and the account page treat it like any other key.
 */

export const OAUTH_SCOPE = "mcp";
export const REFRESH_PREFIX = "wsu_ort_";
const CODE_TTL_MINUTES = 10;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 90;

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  /** True when client_id is a metadata document URL: the name and redirects come from that domain. */
  metadata_document: boolean;
}

/** A standard OAuth error, rendered as { error, error_description }. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export function resourceUrl(services: Services): string {
  return `${services.config.PUBLIC_BASE_URL}/mcp`;
}

export function protectedResourceMetadata(services: Services) {
  const base = services.config.PUBLIC_BASE_URL;
  return {
    resource: resourceUrl(services),
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "WhichSitesUse",
    resource_documentation: base,
  };
}

export function authorizationServerMetadata(services: Services) {
  const base = services.config.PUBLIC_BASE_URL;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    // The redirect back carries iss (RFC 9207), so clients like ChatGPT can use one stable client identity.
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
}

/**
 * Redirect URIs a client may register: https anywhere, http only on loopback
 * (native apps, RFC 8252), or an app's own scheme (cursor://, vscode://).
 * Never javascript:, data:, file: or a fragment.
 */
export function validRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.length > 2000) return false;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return true;
  if (scheme === "http") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !["javascript", "data", "file", "vbscript", "blob", "about"].includes(scheme);
}

/** Dynamic client registration (RFC 7591). */
export async function registerClient(
  services: Services,
  body: Record<string, unknown>,
  ip: string | null,
): Promise<Record<string, unknown>> {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirectUri(u))) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1 to 10 https, loopback http, or app-scheme URIs.");
  }
  const method = (body.token_endpoint_auth_method ?? "none") as AuthMethod;
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  }
  const grants = body.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => !["authorization_code", "refresh_token"].includes(g as string)))) {
    throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const name = (typeof body.client_name === "string" ? body.client_name : "").trim().slice(0, 100) || "An MCP client";
  const clientId = `wsu_client_${randomToken(16)}`;
  const secret = method === "none" ? null : `wsu_cs_${randomToken(32)}`;
  await services.db.query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [clientId, secret ? sha256(secret) : null, name, uris, method, ip],
  );
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: OAUTH_SCOPE,
  };
}

/**
 * A registered client, or the client a metadata document URL describes (fetched and cached).
 * Throws OAuthError when a metadata document can't be fetched or isn't valid.
 */
export async function getClient(services: Services, clientId: string): Promise<OAuthClient | null> {
  if (isMetadataClientId(clientId)) return resolveMetadataClient(services, clientId);
  const { rows } = await services.db.query<OAuthClient>(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, metadata_document
       FROM oauth_clients WHERE client_id = $1 AND NOT metadata_document`,
    [clientId],
  );
  return rows[0] ?? null;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Whether a requested redirect_uri is one the client registered. Exact match, except that
 * loopback http redirects may use any port (RFC 8252 §7.3, OAuth 2.1): native apps like
 * Claude Code pick a free port each time and register "http://localhost/callback".
 */
export function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !LOOPBACK.includes(req.hostname) || req.hash) return false;
  const withoutPort = (u: URL) => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return reg.protocol === "http:" && reg.hostname === req.hostname && withoutPort(reg) === withoutPort(req);
    } catch {
      return false;
    }
  });
}

/** Confidential clients must send their secret; public ones must not pretend to. */
export function checkClientSecret(client: OAuthClient, secret: string | undefined): void {
  if (client.token_endpoint_auth_method === "none") return;
  if (!secret || !client.client_secret_hash || !safeEqual(sha256(secret), client.client_secret_hash)) {
    throw new OAuthError("invalid_client", "Client authentication failed.", 401);
  }
}

/** A requested resource (RFC 8707) must be this server's MCP endpoint (or its origin). */
export function checkResource(services: Services, resource: unknown): void {
  if (resource === undefined || resource === null || resource === "") return;
  const strip = (s: string) => s.replace(/\/+$/, "");
  const ok = [resourceUrl(services), services.config.PUBLIC_BASE_URL].map(strip);
  if (typeof resource !== "string" || !ok.includes(strip(resource))) {
    throw new OAuthError("invalid_target", "This server only issues tokens for its own MCP endpoint.");
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** After the person approves on the consent page. */
export async function createCode(
  services: Services,
  input: { clientId: string; accountId: string; redirectUri: string; codeChallenge: string; monthlyCap: number | null },
): Promise<string> {
  const code = randomToken(32);
  await services.db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, monthly_credit_cap, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))`,
    [sha256(code), input.clientId, input.accountId, input.redirectUri, input.codeChallenge, OAUTH_SCOPE, input.monthlyCap, CODE_TTL_MINUTES],
  );
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(client: pg.PoolClient, apiKeyId: string): Promise<TokenResponse> {
  const access = `${OAUTH_ACCESS_PREFIX}${randomToken(32)}`;
  const refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
  await client.query(
    `INSERT INTO oauth_tokens (api_key_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, now() + make_interval(days => $5))`,
    [apiKeyId, sha256(access), ACCESS_TTL_SECONDS, sha256(refresh), REFRESH_TTL_DAYS],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: OAUTH_SCOPE };
}

/** Revokes a connection: its api_keys row and every token it holds. */
async function revokeConnection(client: pg.PoolClient | pg.Pool, apiKeyId: string): Promise<void> {
  await client.query(`UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1`, [apiKeyId]);
  await client.query(`UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE api_key_id = $1`, [apiKeyId]);
}

/** grant_type=authorization_code */
export async function exchangeCode(
  services: Services,
  client: OAuthClient,
  params: { code?: string; redirectUri?: string; codeVerifier?: string; resource?: unknown },
): Promise<TokenResponse> {
  checkResource(services, params.resource);
  if (!params.code || !params.codeVerifier) throw new OAuthError("invalid_request", "code and code_verifier are required.");
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(params.codeVerifier)) {
    throw new OAuthError("invalid_grant", "code_verifier must be 43 to 128 unreserved characters.");
  }
  const result = await withTransaction(services.db, async (c): Promise<TokenResponse | OAuthError> => {
    const { rows } = await c.query<{
      client_id: string; account_id: string; redirect_uri: string; code_challenge: string;
      monthly_credit_cap: number | null; expired: boolean; used_at: Date | null; api_key_id: string | null;
    }>(
      `SELECT client_id, account_id, redirect_uri, code_challenge, monthly_credit_cap, expires_at <= now() AS expired, used_at, api_key_id
         FROM oauth_codes WHERE code_hash = $1 FOR UPDATE`,
      [sha256(params.code!)],
    );
    const row = rows[0];
    if (!row || row.client_id !== client.client_id) throw new OAuthError("invalid_grant", "Unknown authorization code.");
    if (row.used_at) {
      // A replayed code means it leaked: shut down what it was exchanged for (OAuth 2.1 §4.1.3).
      // Returned, not thrown, so the revocation commits.
      if (row.api_key_id) await revokeConnection(c, row.api_key_id);
      return new OAuthError("invalid_grant", "This authorization code was already used.");
    }
    if (row.expired) throw new OAuthError("invalid_grant", "This authorization code has expired.");
    if (params.redirectUri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (!safeEqual(pkceChallenge(params.codeVerifier!), row.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");

    const account = await services.accounts.byId(row.account_id, c);
    if (!account || account.status !== "active") throw new OAuthError("invalid_grant", "This account can't be connected.");
    const key = await c.query<{ id: string }>(
      `INSERT INTO api_keys (account_id, name, prefix, key_hash, monthly_credit_cap, oauth_client_id)
       VALUES ($1, $2, 'connected app', $3, $4, $5) RETURNING id`,
      // key_hash is a random value nobody holds: the connection is only reachable through its tokens.
      [account.id, client.client_name.slice(0, 60), sha256(randomToken(32)), row.monthly_credit_cap, client.client_id],
    );
    const apiKeyId = key.rows[0]!.id;
    await c.query(`UPDATE oauth_codes SET used_at = now(), api_key_id = $2 WHERE code_hash = $1`, [sha256(params.code!), apiKeyId]);
    return issueTokens(c, apiKeyId);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/** grant_type=refresh_token, rotating: the old refresh token stops working. */
export async function refreshTokens(
  services: Services,
  client: OAuthClient,
  params: { refreshToken?: string; resource?: unknown },
): Promise<TokenResponse> {
  checkResource(services, params.resource);
  if (!params.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
  const result = await withTransaction(services.db, async (c): Promise<TokenResponse | OAuthError> => {
    const { rows } = await c.query<{ id: string; api_key_id: string; revoked: boolean; expired: boolean; client_id: string | null; key_revoked: boolean }>(
      `SELECT t.id, t.api_key_id, t.revoked_at IS NOT NULL AS revoked, t.refresh_expires_at <= now() AS expired,
              k.oauth_client_id AS client_id, k.revoked_at IS NOT NULL AS key_revoked
         FROM oauth_tokens t JOIN api_keys k ON k.id = t.api_key_id
        WHERE t.refresh_hash = $1 FOR UPDATE OF t`,
      [sha256(params.refreshToken!)],
    );
    const row = rows[0];
    if (!row || row.client_id !== client.client_id) throw new OAuthError("invalid_grant", "Unknown refresh token.");
    if (row.revoked && !row.key_revoked) {
      // A rotated-out refresh token came back: someone else has a copy. End the connection.
      await revokeConnection(c, row.api_key_id);
      return new OAuthError("invalid_grant", "This refresh token was already used.");
    }
    if (row.revoked || row.key_revoked) throw new OAuthError("invalid_grant", "This connection was revoked.");
    if (row.expired) throw new OAuthError("invalid_grant", "This refresh token has expired.");
    await c.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
    return issueTokens(c, row.api_key_id);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/** RFC 7009: revoking either token of a pair revokes the pair. Unknown tokens are not an error. */
export async function revokeToken(services: Services, client: OAuthClient, token: string | undefined): Promise<void> {
  if (!token) return;
  const hash = sha256(token);
  await services.db.query(
    `UPDATE oauth_tokens t SET revoked_at = coalesce(t.revoked_at, now())
       FROM api_keys k
      WHERE k.id = t.api_key_id AND k.oauth_client_id = $2 AND (t.access_hash = $1 OR t.refresh_hash = $1)`,
    [hash, client.client_id],
  );
}
