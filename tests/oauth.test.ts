import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { validRedirectUri } from "../src/auth/oauth.js";
import { safeNext } from "../src/web/signup.js";
import { Browser, listen } from "./helpers/browser.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

describe("redirect URIs and return paths", () => {
  it("allows https, loopback http and app schemes only", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(validRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(validRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(validRedirectUri("http://evil.example/callback")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("only returns to same-site paths after sign-in", () => {
    expect(safeNext("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(safeNext("//evil.example")).toBeNull();
    expect(safeNext("/\\evil.example")).toBeNull();
    expect(safeNext("https://evil.example")).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("OAuth for MCP clients", () => {
  let t: TestDb;
  let server: Server;
  let base: string;
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

  beforeAll(async () => {
    t = await createTestDb();
    ({ server, base } = await listen(createApp({ config: t.config, getSnapshot: () => null, services: t.services })));
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };
  const json = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });

  async function register(extra: Record<string, unknown> = {}) {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], ...extra }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  /** A signed-in browser for `email` (a session row, as the magic link would create). */
  async function signedIn(email: string, opts: { credits?: number } = {}) {
    const made = await makeAccount(t.services, email, { credits: opts.credits ?? 100, paid: true });
    const b = new Browser(base);
    const token = randomBytes(24).toString("hex");
    await t.db.query(`INSERT INTO web_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      made.account.id,
      createHash("sha256").update(token).digest("hex"),
    ]);
    (b as any).cookies.set("wsu_session", token); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { b, ...made };
  }

  function authorizePath(clientId: string, challenge: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: "S256", state: "st4te", scope: "mcp", resource: `${t.config.PUBLIC_BASE_URL}/mcp`, ...extra,
    });
    return `/oauth/authorize?${q}`;
  }

  /** Runs consent and returns the code from the redirect. */
  async function approve(b: Browser, path: string, fields: Record<string, string> = {}) {
    const res = await b.post("/oauth/authorize", { ...Object.fromEntries(new URL(base + path).searchParams), decision: "approve", ...fields }, path);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st4te");
    expect(loc.searchParams.get("iss")).toBe(t.config.PUBLIC_BASE_URL);
    return loc.searchParams.get("code")!;
  }

  it("publishes resource and authorization server metadata", async () => {
    const resource = await json(await fetch(`${base}/.well-known/oauth-protected-resource`));
    expect(resource).toMatchObject({ resource: `${t.config.PUBLIC_BASE_URL}/mcp`, authorization_servers: [t.config.PUBLIC_BASE_URL] });
    const server = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(server).toMatchObject({
      issuer: t.config.PUBLIC_BASE_URL,
      code_challenge_methods_supported: ["S256"],
      registration_endpoint: `${t.config.PUBLIC_BASE_URL}/oauth/register`,
    });
    const preflight = await fetch(`${base}/oauth/token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses to register unsafe redirect URIs", async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_redirect_uri");
  });

  it("runs the whole flow: register, consent, token, MCP call, refresh, disconnect", async () => {
    const client = await register();
    const { b, account } = await signedIn("oauth@acme.com", { credits: 100 });
    const { verifier, challenge } = pkce();
    const path = authorizePath(client.client_id, challenge);

    const consent = await b.get(path);
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("calls itself <b>Claude</b>");
    expect(consentHtml).toContain("hasn't verified it");
    expect(consent.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(consent.headers.get("x-frame-options")).toBe("DENY");
    const code = await approve(b, path, { cap: "40" });

    const tokenRes = await form("/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: `${t.config.PUBLIC_BASE_URL}/mcp`,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = await json(tokenRes);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(tokens.access_token).toMatch(/^wsu_oat_/);

    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const bal = await mcp.callTool({ name: "get_balance", arguments: {} });
    expect((bal.structuredContent as any).data).toMatchObject({ credits: { total: 100 }, key: { name: "Claude", monthly_credit_cap: 40 } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await mcp.close();

    // The connection shows on the account page, like a key.
    expect(await (await b.get("/account")).text()).toContain("connected app");

    // Refresh rotates: the new pair works, the old refresh token doesn't.
    const refreshed = await json(await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const bal2 = await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(bal2.status).toBe(200);

    // Disconnecting from the account page ends every token.
    const [key] = (await t.services.accounts.listKeys(account.id)).filter((k) => k.oauth_client_id);
    await b.post(`/account/keys/${key!.id}/revoke`, {}, "/account");
    const after = await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("rejects a wrong PKCE verifier, a reused code, and a reused refresh token", async () => {
    const client = await register();
    const { b } = await signedIn("pkce@acme.com");
    const { verifier, challenge } = pkce();
    const code = await approve(b, authorizePath(client.client_id, challenge));

    const wrong = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: pkce().verifier });
    expect((await json(wrong)).error).toBe("invalid_grant");

    const ok = await json(await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }));
    expect(ok.access_token).toBeTruthy();
    // Replaying the code revokes what it was exchanged for.
    const replay = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
    expect(replay.status).toBe(400);
    expect((await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${ok.access_token}` } })).status).toBe(401);

    // A rotated-out refresh token coming back ends the connection too.
    const code2 = await approve(b, authorizePath(client.client_id, challenge));
    const t1 = await json(await form("/oauth/token", { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }));
    const t2 = await json(await form("/oauth/token", { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: client.client_id }));
    const reused = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: client.client_id });
    expect((await json(reused)).error).toBe("invalid_grant");
    expect((await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(401);
  });

  it("sends signed-out people to sign in and back to consent", async () => {
    const client = await register();
    const path = authorizePath(client.client_id, pkce().challenge);
    const res = await new Browser(base).get(path);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);

    await makeAccount(t.services, "returning@acme.com");
    t.mailer.sent.length = 0;
    await new Browser(base).post("/login", { email: "returning@acme.com", next: path }, "/login");
    const link = new URL(t.mailer.sent[0]!.text.match(/(http\S+\/auth\/\S+)/)![1]!);
    expect(link.searchParams.get("next")).toBe(path);
    const b = new Browser(base);
    const done = await b.post(link.pathname + link.search, {}, link.pathname + link.search);
    expect(done.headers.get("location")).toBe(path);
  });

  it("never redirects to an unregistered return address, and reports denial", async () => {
    const client = await register();
    const { b } = await signedIn("deny@acme.com");
    const bad = await b.get(authorizePath(client.client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }));
    expect(bad.status).toBe(400);

    const path = authorizePath(client.client_id, pkce().challenge);
    const denied = await b.post("/oauth/authorize", { ...Object.fromEntries(new URL(base + path).searchParams), decision: "deny" }, path);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");

    const noPkce = await b.get(authorizePath(client.client_id, "", { code_challenge_method: "plain" }));
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("authenticates confidential clients", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(client.client_secret).toMatch(/^wsu_cs_/);
    const { b } = await signedIn("confidential@acme.com");
    const { verifier, challenge } = pkce();
    const code = await approve(b, authorizePath(client.client_id, challenge));
    const body = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier };
    const noSecret = await form("/oauth/token", { ...body, client_id: client.client_id });
    expect(noSecret.status).toBe(401);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
    const ok = await form("/oauth/token", body, { authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
  });
});
