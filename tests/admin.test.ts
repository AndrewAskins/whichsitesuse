import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { randomToken, sha256 } from "../src/auth/tokens.js";
import type { Services } from "../src/services.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

/**
 * grantFreeCredits is built separately (src/auth/freeGrant.ts); here it is a
 * stand-in that does what its contract says (trial lot + free_grants row), so
 * these tests cover the admin page on its own.
 */
const { grantFreeCredits } = vi.hoisted(() => ({
  grantFreeCredits: vi.fn(
    async (services: Services, accountId: string, opts: { status: string; by: string }, client?: pg.PoolClient): Promise<boolean> => {
      const c = client ?? services.db;
      const acct = await c.query<{ email_normalized: string }>("SELECT email_normalized FROM accounts WHERE id = $1", [accountId]);
      await c.query(
        `INSERT INTO free_grants (account_id, email_normalized, status, credits) VALUES ($1, $2, $3, 250)
         ON CONFLICT (account_id) DO UPDATE SET status = excluded.status, credits = 250`,
        [accountId, acct.rows[0]!.email_normalized, opts.status],
      );
      return services.ledger.addLot(
        { accountId, bucket: "trial", kind: "grant", credits: 250, ref: `grant:${accountId}`, createdBy: opts.by },
        client,
      );
    },
  ),
}));
vi.mock("../src/auth/freeGrant.js", () => ({ grantFreeCredits, releaseWithheldGrant: vi.fn() }));

let t: TestDb;
let services: Services;
let server: Server;
let base: string;
let adminCookie: string;
let adminId: string;

async function signIn(accountId: string): Promise<string> {
  const token = randomToken(32);
  await services.db.query(
    `INSERT INTO web_sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [accountId, sha256(token)],
  );
  return `wsu_session=${token}`;
}

const get = (path: string, cookie = adminCookie) => fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });

async function csrfFor(cookie: string): Promise<string> {
  const body = await (await get("/admin/domains", cookie)).text();
  return /name="csrf" value="([^"]+)"/.exec(body)![1]!;
}

async function post(path: string, fields: Record<string, string>, opts: { cookie?: string; csrf?: boolean } = {}) {
  const cookie = opts.cookie ?? adminCookie;
  const form = new URLSearchParams(fields);
  if (opts.csrf !== false) form.set("csrf", await csrfFor(cookie));
  return fetch(`${base}${path}`, { method: "POST", headers: { cookie }, body: form, redirect: "manual" });
}

/** An account whose grant was withheld for its email domain, with a pending request. */
async function pendingRequest(email: string, message = "I run an agency") {
  const { account } = await makeAccount(services, email);
  await services.db.query(
    `INSERT INTO free_grants (account_id, email_normalized, status, reason, ip_prefix) VALUES ($1, $2, 'withheld', 'not_work_email', '198.51.100.0/24')`,
    [account.id, account.email_normalized],
  );
  await services.db.query(
    `INSERT INTO abuse_signals (account_id, kind, email_domain) VALUES ($1, 'grant_withheld_not_work_email', $2)`,
    [account.id, account.email_domain],
  );
  const { rows } = await services.db.query<{ id: string }>(
    `INSERT INTO free_credit_requests (account_id, message) VALUES ($1, $2) RETURNING id`,
    [account.id, message],
  );
  return { account, requestId: rows[0]!.id };
}

describe.skipIf(!TEST_DATABASE_URL)("admin pages", () => {
  beforeAll(async () => {
    t = await createTestDb();
    services = t.services;
    const app = createApp({ config: t.config, getSnapshot: () => null, services });
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = await makeAccount(services, "admin@example.com", { admin: true });
    adminId = admin.account.id;
    adminCookie = await signIn(adminId);
    await services.db.query(
      `INSERT INTO blocked_email_domains (domain, list, source) VALUES ('gmail.com', 'freemail', 'test'), ('mailinator.com', 'disposable', 'test')`,
    );
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });
  beforeEach(() => {
    grantFreeCredits.mockClear();
  });

  it("sends signed-out visitors to sign in and hides itself from non-admins", async () => {
    const anon = await fetch(`${base}/admin`, { redirect: "manual" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toMatch(/^\/login/);

    const { account } = await makeAccount(services, "someone@example.com");
    const cookie = await signIn(account.id);
    expect((await get("/admin", cookie)).status).toBe(404);
    expect((await get("/admin/accounts", cookie)).status).toBe(404);
    const form = new URLSearchParams({ credits: "1000", note: "x" });
    const res = await fetch(`${base}/admin/accounts/${account.id}/credits`, { method: "POST", headers: { cookie }, body: form, redirect: "manual" });
    expect(res.status).toBe(404);
    expect((await services.ledger.balance(account.id)).total).toBe(0);
  });

  it("renders every page for an admin", async () => {
    const { account } = await pendingRequest("pages@agency.test");
    for (const path of ["/admin", "/admin/requests", "/admin/accounts", "/admin/accounts?q=pages", `/admin/accounts/${account.id}`, "/admin/domains"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
    const dash = await (await get("/admin")).text();
    expect(dash).toContain("Abuse dashboard");
    expect(dash).toContain("198.51.100.0/24");
    expect((await get("/admin/accounts/not-a-uuid")).status).toBe(404);
    expect((await get("/admin/accounts/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("refuses a POST without the CSRF token", async () => {
    const { requestId } = await pendingRequest("nocsrf@agency.test");
    const res = await post(`/admin/requests/${requestId}/approve`, {}, { csrf: false });
    expect(res.status).toBe(403);
    expect(grantFreeCredits).not.toHaveBeenCalled();
    const wrong = await fetch(`${base}/admin/requests/${requestId}/approve`, {
      method: "POST",
      headers: { cookie: adminCookie },
      body: new URLSearchParams({ csrf: "forged" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(403);
  });

  it("lists pending requests with their reason and signals, escaping what users wrote", async () => {
    await pendingRequest("xss@agency.test", "<script>alert(1)</script>");
    const body = await (await get("/admin/requests")).text();
    expect(body).toContain("xss@agency.test");
    expect(body).toContain("not_work_email");
    expect(body).toContain("grant_withheld_not_work_email");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("also allow agency.test");
  });

  it("approves a request, grants by hand and allowlists the domain", async () => {
    const { account, requestId } = await pendingRequest("owner@approved.test");
    const res = await post(`/admin/requests/${requestId}/approve`, { allow_domain: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/requests?msg=approved_domain");

    expect(grantFreeCredits).toHaveBeenCalledTimes(1);
    const [, accountId, opts, client] = grantFreeCredits.mock.calls[0]!;
    expect(accountId).toBe(account.id);
    expect(opts).toEqual({ status: "manual", by: "admin@example.com" });
    expect(client).toBeDefined();

    const r = await services.db.query("SELECT status, reviewed_by, reviewed_at FROM free_credit_requests WHERE id = $1", [requestId]);
    expect(r.rows[0]).toMatchObject({ status: "approved", reviewed_by: "admin@example.com" });
    expect(r.rows[0].reviewed_at).not.toBeNull();
    const d = await services.db.query("SELECT approved_by FROM allowed_email_domains WHERE domain = 'approved.test'");
    expect(d.rows[0]).toEqual({ approved_by: "admin@example.com" });
    expect((await services.ledger.balance(account.id)).trial).toBe(250);

    // A second approval of the same request changes nothing.
    const again = await post(`/admin/requests/${requestId}/approve`, {});
    expect(again.headers.get("location")).toBe("/admin/requests?msg=not_pending");
    expect(grantFreeCredits).toHaveBeenCalledTimes(1);
  });

  it("never allowlists a free-mail domain, and shows no checkbox for one", async () => {
    const { requestId } = await pendingRequest("someone@gmail.com");
    expect(await (await get("/admin/requests")).text()).not.toContain("also allow gmail.com");
    const res = await post(`/admin/requests/${requestId}/approve`, { allow_domain: "1" });
    expect(res.headers.get("location")).toBe("/admin/requests?msg=approved");
    const d = await services.db.query("SELECT 1 FROM allowed_email_domains WHERE domain = 'gmail.com'");
    expect(d.rowCount).toBe(0);
  });

  it("denies a request", async () => {
    const { requestId } = await pendingRequest("deny@agency.test");
    const res = await post(`/admin/requests/${requestId}/deny`, {});
    expect(res.headers.get("location")).toBe("/admin/requests?msg=denied");
    const r = await services.db.query("SELECT status, reviewed_by FROM free_credit_requests WHERE id = $1", [requestId]);
    expect(r.rows[0]).toEqual({ status: "denied", reviewed_by: "admin@example.com" });
    expect(grantFreeCredits).not.toHaveBeenCalled();
  });

  it("finds accounts by email", async () => {
    await makeAccount(services, "findme_1@search.test");
    const body = await (await get("/admin/accounts?q=findme_")).text();
    expect(body).toContain("findme_1@search.test");
    expect(body).not.toContain("admin@example.com</a>");
  });

  it("revokes in one action: zeroes trial credits, revokes keys and suspends", async () => {
    const { account, secret } = await makeAccount(services, "farmer@farm.test", { credits: 250, bucket: "trial" });
    await services.ledger.addLot({ accountId: account.id, bucket: "topup", kind: "topup", credits: 100 });
    await services.ledger.spend(account.id, 20, "u1"); // top-ups are spent before the trial grant
    await services.accounts.createKey(account.id, "second");
    await services.db.query(
      `INSERT INTO free_grants (account_id, email_normalized, status, credits) VALUES ($1, $2, 'granted', 250)`,
      [account.id, account.email_normalized],
    );

    const res = await post(`/admin/accounts/${account.id}/revoke`, { reason: "farming grants" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/accounts/${account.id}?msg=revoked&n=250`);

    const balance = await services.ledger.balance(account.id);
    expect(balance).toMatchObject({ trial: 0, topup: 80 });
    const keys = await services.accounts.listKeys(account.id);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.revoked_at !== null)).toBe(true);
    expect(await services.accounts.authenticate(secret)).toBeNull();
    const after = (await services.accounts.byId(account.id))!;
    expect(after).toMatchObject({ status: "suspended", suspended_reason: "farming grants" });
    const g = await services.db.query("SELECT status FROM free_grants WHERE account_id = $1", [account.id]);
    expect(g.rows[0].status).toBe("revoked");
    const [row] = await services.ledger.history(account.id, 1);
    expect(row).toMatchObject({ kind: "revoke", amount: -250, note: "farming grants", created_by: "admin@example.com" });

    const page = await (await get(`/admin/accounts/${account.id}?msg=revoked&n=250`)).text();
    expect(page).toContain("Revoked 250 unspent trial credits");

    const unsuspend = await post(`/admin/accounts/${account.id}/unsuspend`, {});
    expect(unsuspend.headers.get("location")).toBe(`/admin/accounts/${account.id}?msg=unsuspended`);
    expect((await services.accounts.byId(account.id))!.status).toBe("active");
  });

  it("requires a reason to revoke", async () => {
    const { account } = await makeAccount(services, "noreason@farm.test", { credits: 250, bucket: "trial" });
    const res = await post(`/admin/accounts/${account.id}/revoke`, { reason: "  " });
    expect(res.headers.get("location")).toBe(`/admin/accounts/${account.id}?msg=invalid_reason`);
    expect((await services.ledger.balance(account.id)).trial).toBe(250);
  });

  it("adds credits by hand as an adjustment", async () => {
    const { account } = await makeAccount(services, "goodwill@agency.test");
    const res = await post(`/admin/accounts/${account.id}/credits`, { credits: "500", note: "sorry for the outage" });
    expect(res.headers.get("location")).toBe(`/admin/accounts/${account.id}?msg=credits_added&n=500`);
    expect((await services.ledger.balance(account.id)).topup).toBe(500);
    const [row] = await services.ledger.history(account.id, 1);
    expect(row).toMatchObject({ kind: "adjust", amount: 500, ref: null, note: "sorry for the outage", created_by: "admin@example.com" });
    const lot = await services.db.query("SELECT expires_at FROM credit_lots WHERE account_id = $1", [account.id]);
    expect(lot.rows[0].expires_at).toBeNull();

    for (const credits of ["0", "-5", "1.5", "abc", "2000000"]) {
      const bad = await post(`/admin/accounts/${account.id}/credits`, { credits, note: "x" });
      expect(bad.headers.get("location"), credits).toBe(`/admin/accounts/${account.id}?msg=invalid_credits`);
    }
    const noNote = await post(`/admin/accounts/${account.id}/credits`, { credits: "10", note: "" });
    expect(noNote.headers.get("location")).toBe(`/admin/accounts/${account.id}?msg=invalid_credits`);
    expect((await services.ledger.balance(account.id)).topup).toBe(500);
  });

  it("manages the domain allowlist", async () => {
    let res = await post("/admin/domains", { domain: " @Partner.Example ", note: "reseller" });
    expect(res.headers.get("location")).toBe("/admin/domains?msg=domain_added");
    res = await post("/admin/domains", { domain: "partner.example" });
    expect(res.headers.get("location")).toBe("/admin/domains?msg=domain_exists");
    res = await post("/admin/domains", { domain: "gmail.com" });
    expect(res.headers.get("location")).toBe("/admin/domains?msg=domain_blocked");
    res = await post("/admin/domains", { domain: "not a domain" });
    expect(res.headers.get("location")).toBe("/admin/domains?msg=invalid_domain");
    expect(await (await get("/admin/domains")).text()).toContain("partner.example");

    res = await post("/admin/domains/partner.example/delete", {});
    expect(res.headers.get("location")).toBe("/admin/domains?msg=domain_removed");
    const d = await services.db.query("SELECT 1 FROM allowed_email_domains WHERE domain = 'partner.example'");
    expect(d.rowCount).toBe(0);
  });

  it("shows only known notices", async () => {
    const body = await (await get("/admin/domains?msg=Your+account+is+compromised")).text();
    expect(body).not.toContain("compromised");
  });
});
