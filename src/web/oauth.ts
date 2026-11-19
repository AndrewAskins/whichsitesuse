import express, { Router, type NextFunction, type Request, type Response } from "express";
import { RateLimiter } from "../abuse/rateLimit.js";
import {
  OAUTH_SCOPE,
  OAuthError,
  authorizationServerMetadata,
  checkClientSecret,
  checkResource,
  createCode,
  exchangeCode,
  getClient,
  protectedResourceMetadata,
  refreshTokens,
  registerClient,
  revokeToken,
  type OAuthClient,
} from "../auth/oauth.js";
import { log } from "../log.js";
import type { Services } from "../services.js";
import { csrfField, html, page } from "./layout.js";
import { locals, requireCsrf } from "./session.js";

/** Browser-based MCP clients call these cross-origin. No cookies are involved, so "*" is safe. */
export function cors(req: Request, res: Response, next: NextFunction) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

/** Where a 401 points MCP clients to start OAuth (RFC 9728). */
export function wwwAuthenticate(services: Services, error?: "invalid_token"): string {
  const meta = `${services.config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${meta}"${error ? `, error="${error}"` : ""}`;
}

/** Metadata, registration, token and revocation endpoints: JSON in and out, no session. */
export function oauthApiRoutes(services: Services): Router {
  const router = Router();
  const registerLimiter = new RateLimiter(3600_000);
  const tokenLimiter = new RateLimiter();
  router.use(["/.well-known", "/oauth/register", "/oauth/token", "/oauth/revoke"], cors);
  router.use(["/oauth/token", "/oauth/revoke"], express.urlencoded({ extended: false, limit: "16kb" }));

  const resourceMeta = (_req: Request, res: Response) => res.json(protectedResourceMetadata(services));
  router.get("/.well-known/oauth-protected-resource", resourceMeta);
  router.get("/.well-known/oauth-protected-resource/mcp", resourceMeta);
  const serverMeta = (_req: Request, res: Response) => res.json(authorizationServerMetadata(services));
  router.get("/.well-known/oauth-authorization-server", serverMeta);
  router.get("/.well-known/oauth-authorization-server/mcp", serverMeta);

  router.post("/oauth/register", async (req, res) => {
    try {
      if (registerLimiter.hit(`reg:${req.ip}`, 20) > 0) throw new OAuthError("too_many_requests", "Too many registrations from this network.", 429);
      res.status(201).set("Cache-Control", "no-store").json(await registerClient(services, req.body ?? {}, req.ip ?? null));
    } catch (err) {
      oauthError(res, err);
    }
  });

  router.post("/oauth/token", async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    try {
      if (tokenLimiter.hit(`tok:${req.ip}`, 60) > 0) throw new OAuthError("too_many_requests", "Slow down.", 429);
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      const client = await authenticateClient(services, req, body);
      if (body.grant_type === "authorization_code") {
        res.json(await exchangeCode(services, client, { code: body.code, redirectUri: body.redirect_uri, codeVerifier: body.code_verifier, resource: body.resource }));
      } else if (body.grant_type === "refresh_token") {
        res.json(await refreshTokens(services, client, { refreshToken: body.refresh_token, resource: body.resource }));
      } else {
        throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
      }
    } catch (err) {
      oauthError(res, err);
    }
  });

  router.post("/oauth/revoke", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      const client = await authenticateClient(services, req, body);
      await revokeToken(services, client, body.token);
      res.status(200).end();
    } catch (err) {
      oauthError(res, err);
    }
  });

  return router;
}

/** client_id and secret from the body (client_secret_post) or a Basic header (client_secret_basic). */
async function authenticateClient(services: Services, req: Request, body: Record<string, string | undefined>): Promise<OAuthClient> {
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const [u, p] = Buffer.from(basic, "base64").toString("utf8").split(":");
    id = decodeURIComponent(u ?? "");
    secret = decodeURIComponent(p ?? "");
  }
  const client = id ? await getClient(services, id) : null;
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
  checkClientSecret(client, secret);
  return client;
}

function oauthError(res: Response, err: unknown) {
  if (err instanceof OAuthError) {
    if (err.status === 401) res.set("WWW-Authenticate", 'Basic realm="whichsitesuse"');
    res.status(err.status).json(err.toJSON());
    return;
  }
  log.error({ err }, "oauth endpoint failed");
  res.status(500).json({ error: "server_error", error_description: "Something went wrong on our side." });
}

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
}

/**
 * The consent page (GET) and the decision (POST). Mounted inside the web router,
 * so the session and CSRF token are there.
 */
export function oauthConsentRoutes(services: Services): Router {
  const router = Router();
  const issuer = services.config.PUBLIC_BASE_URL;

  const errorPage = (res: Response, message: string) =>
    res.status(400).send(page({ title: "Can't connect", body: html`<h1>Can't <span class="mark">connect</span></h1><p>${message}</p>` }));

  const redirectBack = (res: Response, redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", issuer);
    res.redirect(303, url.toString());
  };

  /** Validates an authorize request. Returns null after sending a response itself. */
  const parse = async (q: Record<string, unknown>, res: Response): Promise<AuthorizeRequest | null> => {
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
    const client = str("client_id") ? await getClient(services, str("client_id")!) : null;
    if (!client) {
      errorPage(res, "This app isn't registered with WhichSitesUse. Try connecting again from the app.");
      return null;
    }
    const requested = str("redirect_uri");
    const redirectUri = requested ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    // Never redirect to an address the client didn't register: show the error here instead.
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      errorPage(res, "The app sent a return address it didn't register, so we stopped here.");
      return null;
    }
    const state = str("state");
    const fail = (error: string, description: string) => {
      redirectBack(res, redirectUri, { error, error_description: description, state });
      return null;
    };
    if (str("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = str("code_challenge");
    if (!challenge || str("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    const scope = str("scope");
    if (scope && scope.split(" ").some((s) => s && s !== OAUTH_SCOPE)) return fail("invalid_scope", `The only scope is "${OAUTH_SCOPE}".`);
    try {
      checkResource(services, q.resource);
    } catch (err) {
      return fail("invalid_target", (err as Error).message);
    }
    return { client, redirectUri, state, codeChallenge: challenge };
  };

  router.get("/oauth/authorize", async (req, res) => {
    const parsed = await parse(req.query as Record<string, unknown>, res);
    if (!parsed) return;
    const account = locals(res).account;
    if (!account) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (account.status === "suspended") return errorPage(res, "This account is suspended, so it can't connect apps.");
    const q = req.query as Record<string, string>;
    const keep = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource", "response_type"];
    const returnHost = new URL(parsed.redirectUri).host || parsed.redirectUri.split(":")[0];
    res.send(
      page({
        title: "Connect an app",
        signedIn: true,
        isAdmin: account.is_admin,
        body: html`<h1>Connect an <span class="mark">app</span>?</h1>
<p>An app that calls itself <b>${parsed.client.client_name}</b> (a name it chose; WhichSitesUse hasn't verified it) wants to search WhichSitesUse and spend credits from <b>${account.email}</b>'s balance. It can't see your payment details or buy credits by itself.</p>
<p>After you approve, you go back to <b><code>${returnHost}</code></b>. Only approve if you just started connecting an app there. You can disconnect it any time on your account page.</p>
<form method="post" action="/oauth/authorize">${csrfField(locals(res).csrf)}
${keep.filter((k) => typeof q[k] === "string").map((k) => html`<input type="hidden" name="${k}" value="${q[k]}">`)}
<label for="cap" class="label">Monthly credit cap for this app (optional)</label>
<input id="cap" name="cap" type="number" min="0" placeholder="no cap">
<div class="row"><button name="decision" value="approve">approve</button><button class="secondary" name="decision" value="deny">deny</button></div>
</form>`,
      }),
    );
  });

  router.post("/oauth/authorize", requireCsrf, async (req, res) => {
    const account = locals(res).account;
    if (!account) return res.redirect(303, "/login");
    const parsed = await parse(req.body as Record<string, unknown>, res);
    if (!parsed) return;
    if (req.body.decision !== "approve") {
      return redirectBack(res, parsed.redirectUri, { error: "access_denied", error_description: "The person declined.", state: parsed.state });
    }
    if (account.status === "suspended") return errorPage(res, "This account is suspended, so it can't connect apps.");
    const capRaw = String(req.body.cap ?? "").trim();
    const cap = capRaw && Number.isInteger(Number(capRaw)) && Number(capRaw) >= 0 ? Number(capRaw) : null;
    const code = await createCode(services, {
      clientId: parsed.client.client_id,
      accountId: account.id,
      redirectUri: parsed.redirectUri,
      codeChallenge: parsed.codeChallenge,
      monthlyCap: cap,
    });
    redirectBack(res, parsed.redirectUri, { code, state: parsed.state });
  });

  return router;
}
