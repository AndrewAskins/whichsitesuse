import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { grantFreeCredits, releaseWithheldGrant } from "../src/auth/freeGrant.js";
import { Browser, listen } from "./helpers/browser.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

describe.skipIf(!TEST_DATABASE_URL)("sign-up and the free grant", () => {
  let t: TestDb;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    t = await createTestDb({ config: { ADMIN_EMAILS: "andrew@whichsitesuse.com" } });
    ({ server, base } = await listen(createApp({ config: t.config, getSnapshot: () => null, services: t.services })));
  });
  afterAll(async () => {
    server?.close();
    await t?.drop();
  });
  beforeEach(() => {
    t.mailer.sent.length = 0;
  });

  const fp = (c: string) => c.repeat(64);
  let nextNet = 1;

  /** Signs up, opens the emailed link and confirms it; returns the browser and where it landed. */
  async function signUp(email: string, opts: { ip?: string; fp?: string } = {}) {
    const b = new Browser(base, opts.ip ?? `198.51.${nextNet++}.10`);
    const res = await b.post("/signup", { email, fp: opts.fp ?? "" });
    expect(res.status).toBe(200);
    const link = t.mailer.sent.at(-1)!.text.match(/(http\S+\/auth\/\S+)/)![1]!;
    const path = new URL(link).pathname;
    expect((await b.get(path)).status).toBe(200); // the confirm page doesn't use the link
    const done = await b.post(path, {}, path);
    return { b, location: done.headers.get("location"), path };
  }

  const accountFor = (email: string) => t.services.accounts.byEmail(email);
  const balance = async (email: string) => (await t.services.ledger.balance((await accountFor(email))!.id)).total;

  it("grants 250 credits to a verified work email, once", async () => {
    const { b, location, path } = await signUp("ana@acme-agency.com");
    expect(location).toBe("/account?welcome=granted");
    expect(await balance("ana@acme-agency.com")).toBe(250);
    expect((await b.get("/account")).status).toBe(200);
    // The link is single-use.
    expect((await new Browser(base).post(path, {}, "/login")).status).toBe(400);
  });

  it("doesn't credit an account until the link is clicked", async () => {
    const b = new Browser(base);
    await b.post("/signup", { email: "later@acme.com" });
    const account = await accountFor("later@acme.com");
    expect(account?.email_verified_at).toBeNull();
    expect(await balance("later@acme.com")).toBe(0);
  });

  it("lets a free-mail address in without credits, and offers the request form", async () => {
    const { b, location } = await signUp("someone@gmail.com");
    expect(location).toBe("/account?welcome=withheld");
    expect(await balance("someone@gmail.com")).toBe(0);
    expect(await (await b.get("/account")).text()).toContain("/request-credits");
    const sent = await b.post("/request-credits", { message: "Freelance web designer" });
    expect(sent.headers.get("location")).toBe("/account?requested=1");
    const { rows } = await t.db.query("SELECT status, message FROM free_credit_requests");
    expect(rows).toEqual([{ status: "pending", message: "Freelance web designer" }]);
  });

  it("refuses disposable addresses outright", async () => {
    const res = await new Browser(base).post("/signup", { email: "x@mailinator.com" });
    expect(res.status).toBe(400);
    expect(await accountFor("x@mailinator.com")).toBeNull();
  });

  it("treats dots and +tags as the same inbox", async () => {
    await signUp("first.last@gmail.com");
    const b = new Browser(base);
    await b.post("/signup", { email: "first.last+again@gmail.com" });
    expect(await accountFor("first.last+again@gmail.com")).toBeNull();
    expect(t.mailer.sent.at(-1)!.to).toBe("first.last@gmail.com");
  });

  it("withholds the grant from a repeat device, and releases it on payment", async () => {
    await signUp("one@devco.com", { fp: fp("a") });
    const { location } = await signUp("two@otherco.com", { fp: fp("a") });
    expect(location).toBe("/account?welcome=withheld");
    const two = (await accountFor("two@otherco.com"))!;
    const { rows } = await t.db.query("SELECT status, reason FROM free_grants WHERE account_id = $1", [two.id]);
    expect(rows[0]).toEqual({ status: "withheld", reason: "device" });

    await releaseWithheldGrant(t.services, two.id);
    expect(await balance("two@otherco.com")).toBe(250);
  });

  it("withholds the third grant from one network in a week", async () => {
    await signUp("a@net1.com", { ip: "192.0.2.10" });
    await signUp("b@net2.com", { ip: "192.0.2.77" });
    const { location } = await signUp("c@net3.com", { ip: "192.0.2.200" });
    expect(location).toBe("/account?welcome=withheld");
    const signals = await t.db.query("SELECT kind FROM abuse_signals WHERE kind = 'grant_withheld_network'");
    expect(signals.rowCount).toBe(1);
  });

  it("grants by hand once, keeping why it was first withheld", async () => {
    await signUp("hand@hotmail.com");
    const account = (await accountFor("hand@hotmail.com"))!;
    expect(await grantFreeCredits(t.services, account.id, { status: "manual", by: "andrew@whichsitesuse.com" })).toBe(true);
    expect(await grantFreeCredits(t.services, account.id, { status: "manual", by: "andrew@whichsitesuse.com" })).toBe(false);
    expect(await balance("hand@hotmail.com")).toBe(250);
    const { rows } = await t.db.query("SELECT status, reason FROM free_grants WHERE account_id = $1", [account.id]);
    expect(rows[0]).toEqual({ status: "manual", reason: "not_work_email" });
  });

  it("makes ADMIN_EMAILS admins when they verify", async () => {
    await signUp("andrew@whichsitesuse.com");
    expect((await accountFor("andrew@whichsitesuse.com"))!.is_admin).toBe(true);
    expect((await accountFor("ana@acme-agency.com"))!.is_admin).toBe(false);
  });

  it("emails existing accounts a sign-in link and says the same thing to strangers", async () => {
    const known = await new Browser(base).post("/login", { email: "ana@acme-agency.com" });
    const stranger = await new Browser(base).post("/login", { email: "nobody@acme.com" });
    expect(known.status).toBe(200);
    expect(stranger.status).toBe(200);
    expect(t.mailer.sent.map((m) => m.to)).toEqual(["ana@acme-agency.com"]);
    expect(t.mailer.sent[0]!.subject).toMatch(/sign-in/);
  });

  it("rejects forms without the CSRF token", async () => {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=csrf@acme.com",
    });
    expect(res.status).toBe(403);
  });

  it("creates, caps and revokes API keys from the account page", async () => {
    const { b } = await signUp("keys@acme-agency.com");
    const created = await b.post("/account/keys", { name: "claude", cap: "500" }, "/account");
    const secret = (await created.text()).match(/wsu_live_[A-Za-z0-9]+/)![0];
    const bal = await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${secret}` } });
    expect(((await bal.json()) as any).data.key).toMatchObject({ name: "claude", monthly_credit_cap: 500 });

    const account = (await accountFor("keys@acme-agency.com"))!;
    const [key] = await t.services.accounts.listKeys(account.id);
    await b.post(`/account/keys/${key!.id}/revoke`, {}, "/account");
    expect((await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  it("sends signed-out visitors from /account to sign in", async () => {
    const res = await new Browser(base).get("/account");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2Faccount");
  });
});
