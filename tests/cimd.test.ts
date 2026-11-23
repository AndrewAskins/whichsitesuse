import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cacheSeconds, isMetadataClientId, isPublicAddress, parseMetadataDocument, type MetadataResponse } from "../src/auth/cimd.js";
import { redirectAllowed } from "../src/auth/oauth.js";
import { Browser, listen } from "./helpers/browser.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

// The documents Claude and Claude Code publish (fetched November 2026).
const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_DOC = {
  client_id: CLAUDE_ID,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const CODE_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const CODE_DOC = {
  client_id: CODE_ID,
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("client ID metadata documents", () => {
  it("only treats https URLs with a path as metadata client ids", () => {
    expect(isMetadataClientId(CLAUDE_ID)).toBe(true);
    expect(isMetadataClientId("https://chatgpt.com/oauth/client.json")).toBe(true);
    expect(isMetadataClientId("wsu_client_abc")).toBe(false);
    expect(isMetadataClientId("https://claude.ai/")).toBe(false);
    expect(isMetadataClientId("http://claude.ai/oauth/x")).toBe(false);
    expect(isMetadataClientId("https://user:pw@claude.ai/x")).toBe(false);
    expect(isMetadataClientId("https://claude.ai:8443/x")).toBe(false);
    expect(isMetadataClientId("https://10.0.0.1/x")).toBe(false);
    expect(isMetadataClientId("https://claude.ai/x#frag")).toBe(false);
  });

  it("refuses private and special addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("160.79.104.10")).toBe(true);
    expect(isPublicAddress("2607:6bc0::10")).toBe(true);
  });

  it("keeps documents for their max-age, between 5 minutes and a day", () => {
    expect(cacheSeconds("public, max-age=300")).toBe(300);
    expect(cacheSeconds("max-age=10")).toBe(300);
    expect(cacheSeconds("max-age=999999")).toBe(86400);
    expect(cacheSeconds(undefined)).toBe(3600);
    expect(cacheSeconds("no-store")).toBe(300);
  });

  it("validates a document", () => {
    expect(parseMetadataDocument(CLAUDE_ID, JSON.stringify(CLAUDE_DOC))).toEqual({ client_name: "Claude", redirect_uris: CLAUDE_DOC.redirect_uris });
    // ChatGPT leaves out token_endpoint_auth_method.
    const { token_endpoint_auth_method: _m, ...noMethod } = CLAUDE_DOC;
    expect(parseMetadataDocument(CLAUDE_ID, JSON.stringify(noMethod)).client_name).toBe("Claude");
    const bad = (doc: unknown) => () => parseMetadataDocument(CLAUDE_ID, JSON.stringify(doc));
    expect(bad({ ...CLAUDE_DOC, client_id: "https://evil.example/doc" })).toThrow(/doesn't match/);
    expect(bad({ ...CLAUDE_DOC, redirect_uris: ["http://evil.example/cb"] })).toThrow(/redirect_uris/);
    expect(bad({ ...CLAUDE_DOC, token_endpoint_auth_method: "client_secret_basic" })).toThrow(/public clients/);
    expect(bad({ ...CLAUDE_DOC, client_secret: "x" })).toThrow(/secret/);
    expect(() => parseMetadataDocument(CLAUDE_ID, "<html>")).toThrow(/isn't JSON/);
  });

  it("lets loopback redirects use any port, and nothing else", () => {
    expect(redirectAllowed(CODE_DOC.redirect_uris, "http://localhost:51234/callback")).toBe(true);
    expect(redirectAllowed(CODE_DOC.redirect_uris, "http://127.0.0.1:8080/callback")).toBe(true);
    expect(redirectAllowed(CODE_DOC.redirect_uris, "http://localhost:51234/other")).toBe(false);
    expect(redirectAllowed(CODE_DOC.redirect_uris, "http://evil.example:80/callback")).toBe(false);
    expect(redirectAllowed(CLAUDE_DOC.redirect_uris, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed(CLAUDE_DOC.redirect_uris, "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("OAuth with client metadata documents", () => {
  let t: TestDb;
  let server: Server;
  let base: string;
  const docs = new Map<string, MetadataResponse>();
  const fetched: string[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    t.services.fetchClientMetadata = async (url) => {
      fetched.push(url.toString());
      const res = docs.get(url.toString());
      if (!res) throw new Error("getaddrinfo ENOTFOUND");
      return res;
    };
    docs.set(CLAUDE_ID, { status: 200, cacheControl: "public, max-age=300", body: JSON.stringify(CLAUDE_DOC) });
    docs.set(CODE_ID, { status: 200, cacheControl: "public, max-age=300", body: JSON.stringify(CODE_DOC) });
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

  async function signedIn(email: string) {
    const made = await makeAccount(t.services, email, { credits: 100, paid: true });
    const b = new Browser(base);
    const token = randomBytes(24).toString("hex");
    await t.db.query(`INSERT INTO web_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      made.account.id,
      createHash("sha256").update(token).digest("hex"),
    ]);
    (b as any).cookies.set("wsu_session", token); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { b, ...made };
  }

  const authorizePath = (clientId: string, redirect: string, challenge: string) =>
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
      code_challenge_method: "S256", state: "st4te", scope: "mcp", resource: `${t.config.PUBLIC_BASE_URL}/mcp`,
    })}`;

  async function approve(b: Browser, path: string) {
    const res = await b.post("/oauth/authorize", { ...Object.fromEntries(new URL(base + path).searchParams), decision: "approve" }, path);
    expect(res.status).toBe(303);
    return new URL(res.headers.get("location")!);
  }

  it("advertises metadata document support and RFC 9207 iss", async () => {
    const meta = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(meta).toMatchObject({ client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp"');
  });

  it("connects Claude by its published identity, without registering", async () => {
    const { b } = await signedIn("claude-cimd@acme.com");
    const { verifier, challenge } = pkce();
    const redirect = CLAUDE_DOC.redirect_uris[0]!;
    const path = authorizePath(CLAUDE_ID, redirect, challenge);

    const consent = await (await b.get(path)).text();
    expect(consent).toContain("<b>Claude</b>, an app whose details are published at <b><code>claude.ai</code></b>");
    expect(consent).not.toContain("hasn't verified it");

    const loc = await approve(b, path);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("iss")).toBe(t.config.PUBLIC_BASE_URL);
    const tokens = await json(
      await form("/oauth/token", { grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: redirect, client_id: CLAUDE_ID, code_verifier: verifier }),
    );
    expect(tokens.access_token).toMatch(/^wsu_oat_/);

    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const bal = await mcp.callTool({ name: "get_balance", arguments: {} });
    expect((bal.structuredContent as any).data).toMatchObject({ credits: { total: 100 }, key: { name: "Claude" } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await mcp.close();

    const refreshed = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLAUDE_ID });
    expect(refreshed.status).toBe(200);
    // Cached: one fetch covered consent, approval, token exchange and refresh.
    expect(fetched.filter((u) => u === CLAUDE_ID)).toHaveLength(1);
  });

  it("connects Claude Code on whatever loopback port it picked", async () => {
    const { b } = await signedIn("claude-code@acme.com");
    const { verifier, challenge } = pkce();
    const redirect = "http://localhost:49152/callback";
    const path = authorizePath(CODE_ID, redirect, challenge);
    const consent = await (await b.get(path)).text();
    expect(consent).toContain("a program running on this computer");
    const loc = await approve(b, path);
    expect(loc.origin + loc.pathname).toBe(redirect);
    const res = await form("/oauth/token", { grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: redirect, client_id: CODE_ID, code_verifier: verifier });
    expect(res.status).toBe(200);
    // The code is bound to the exact redirect it was issued for.
    const loc2 = await approve(b, path);
    const other = await form("/oauth/token", { grant_type: "authorization_code", code: loc2.searchParams.get("code")!, redirect_uri: "http://localhost:50000/callback", client_id: CODE_ID, code_verifier: verifier });
    expect((await json(other)).error).toBe("invalid_grant");
  });

  it("stops on a document it can't fetch or trust, and on a secret", async () => {
    const { b } = await signedIn("bad-doc@acme.com");
    const missing = await b.get(authorizePath("https://nowhere.example/client.json", "https://nowhere.example/cb", pkce().challenge));
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("check this app&#39;s identity at nowhere.example");

    const forged = "https://forged.example/client.json";
    docs.set(forged, { status: 200, cacheControl: undefined, body: JSON.stringify({ ...CLAUDE_DOC, client_id: CLAUDE_ID }) });
    expect((await b.get(authorizePath(forged, CLAUDE_DOC.redirect_uris[0]!, pkce().challenge))).status).toBe(400);

    // A redirect the document doesn't list is refused here, never followed.
    const elsewhere = await b.get(authorizePath(CLAUDE_ID, "https://evil.example/cb", pkce().challenge));
    expect(elsewhere.status).toBe(400);

    const withSecret = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: "x", client_id: CLAUDE_ID, client_secret: "s" });
    expect(withSecret.status).toBe(401);
  });

  it("never lets a registered client be shadowed by a URL, or a URL client by registration", async () => {
    // Dynamic registration can't claim a URL as its client id, and getClient never returns a URL row for a plain id.
    const reg = await json(
      await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_id: CLAUDE_ID }),
      }),
    );
    expect(reg.client_id).toMatch(/^wsu_client_/);
  });
});
