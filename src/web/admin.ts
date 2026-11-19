import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { loadDashboard, pendingRequestCount, recentSignals, type SignalRow } from "../abuse/stats.js";
import { grantFreeCredits } from "../auth/freeGrant.js";
import { FREE_GRANT, GRANT_SIGNALS } from "../billing/plans.js";
import { log } from "../log.js";
import { withTransaction } from "../db/pool.js";
import type { Services } from "../services.js";
import { csrfField, fmtDate, fmtNum, html, notice, page, type Html } from "./layout.js";
import { locals, requireAdmin, requireCsrf } from "./session.js";

/**
 * The small admin page (spec: "Free-credit abuse controls"): the abuse
 * dashboard, the free-credit request queue, account lookup with the one-action
 * revoke, and the work-email domain allowlist. Server-rendered forms only.
 */

/**
 * Notices shown after a POST. The redirect carries a code (and at most a
 * number), never free text, so a crafted admin link can't put words on the page.
 */
const MESSAGES: Record<string, (n: number | null) => string> = {
  approved: () => "Approved. The free credits were added.",
  approved_no_credits: () => "Approved. No credits were added: this account already had its grant.",
  approved_domain: () => "Approved, and the domain now passes the work-email check.",
  denied: () => "Request denied.",
  not_pending: () => "That request was already reviewed.",
  revoked: (n) => `Revoked ${fmtNum(n)} unspent trial credits, revoked every API key and suspended the account.`,
  unsuspended: () => "Account reactivated. Its old API keys stay revoked; the owner creates new ones.",
  credits_added: (n) => `Added ${fmtNum(n)} credits.`,
  invalid_credits: () => "Credits must be a whole number from 1 to 1,000,000, with a note.",
  invalid_reason: () => "Give a reason (it is shown on the account and in the ledger).",
  domain_added: () => "Domain added to the allowlist.",
  domain_exists: () => "That domain is already on the allowlist.",
  domain_blocked: () => "That is a free-mail or disposable domain; it can't go on the allowlist.",
  invalid_domain: () => "That doesn't look like a domain.",
  domain_removed: () => "Domain removed from the allowlist.",
};

function redirectWith(res: Response, path: string, msg: keyof typeof MESSAGES, n?: number) {
  const q = new URLSearchParams({ msg: String(msg) });
  if (n !== undefined) q.set("n", String(n));
  res.redirect(303, `/admin${path}?${q}`);
}

function flash(req: Request): Html {
  const make = typeof req.query.msg === "string" ? MESSAGES[req.query.msg] : undefined;
  if (!make) return html``;
  const n = typeof req.query.n === "string" && /^\d{1,9}$/.test(req.query.n) ? Number(req.query.n) : null;
  return notice(make(n), "ok");
}

const adminEmail = (res: Response) => locals(res).account!.email;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercased, without a leading "@"; null unless it looks like a registrable domain. */
export function normalizeDomain(input: unknown): string | null {
  const d = String(input ?? "").trim().toLowerCase().replace(/^@/, "");
  const ok = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(d);
  return ok ? d : null;
}

function fmtTime(d: Date | string | null | undefined): string {
  return d ? `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function short(value: unknown, max = 160): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function adminRoutes(services: Services): Router {
  const router = Router();
  const { db, accounts, ledger } = services;
  router.use(requireAdmin);

  async function render(req: Request, res: Response, title: string, body: Html) {
    const pending = await pendingRequestCount(db);
    const nav = html`<p class="mono">
      <a href="/admin">dashboard</a> · <a href="/admin/requests">requests${pending ? html` <span class="mark">${pending}</span>` : ""}</a>
      · <a href="/admin/accounts">accounts</a> · <a href="/admin/domains">domains</a></p>`;
    res.send(page({ title, signedIn: true, isAdmin: true, body: html`${nav}${flash(req)}${body}` }));
  }

  function notFound(req: Request, res: Response, what: string) {
    res.status(404);
    return render(req, res, "Not found", html`<h1>Not found</h1><p class="muted">No such ${what}.</p>`);
  }

  // --- Dashboard ------------------------------------------------------------

  router.get("/", async (req, res) => {
    const d = await loadDashboard(db);
    const today = d.days[0];
    const limit = services.config.ALERT_GRANTS_PER_DAY;
    await render(
      req,
      res,
      "Admin",
      html`<h1>Abuse dashboard</h1>
      <div class="stats">
        <div class="stat"><span class="label">granted today</span><b>${fmtNum(today?.granted)}</b><span class="muted">alert past ${fmtNum(limit)}</span></div>
        <div class="stat"><span class="label">withheld today</span><b>${fmtNum(today?.withheld)}</b></div>
        <div class="stat"><span class="label">grant to paid, 30 days</span><b>${pct(d.conversion.rate)}</b>
          <span class="muted">${fmtNum(d.conversion.paid)} of ${fmtNum(d.conversion.granted)}</span></div>
        <div class="stat"><span class="label">pending requests</span><b><a href="/admin/requests">${fmtNum(d.pendingRequests)}</a></b></div>
      </div>

      <h2>Grants per day</h2>
      <p class="muted">Last 14 UTC days, by the day of the decision and the grant's status now.</p>
      <table><tr><th>day</th><th>granted</th><th>manual</th><th>withheld</th><th>revoked</th></tr>
      ${d.days.map(
        (r) => html`<tr><td class="mono">${r.day}</td><td>${r.granted > limit ? html`<span class="mark">${fmtNum(r.granted)}</span>` : fmtNum(r.granted)}</td>
          <td>${fmtNum(r.manual)}</td><td>${fmtNum(r.withheld)}</td><td>${fmtNum(r.revoked)}</td></tr>`,
      )}</table>

      <h2>Grants per network</h2>
      <p class="muted">Sign-ups with a grant decision in the last ${GRANT_SIGNALS.networkWindowDays} days, by /24 (IPv4) or /48 (IPv6).
        More than ${GRANT_SIGNALS.maxGrantsPerNetwork} withholds the next grant.</p>
      ${d.networks.length
        ? html`<table><tr><th>network</th><th>sign-ups</th><th>granted</th><th>withheld</th><th>last</th></tr>
          ${d.networks.map(
            (n) => html`<tr><td class="mono">${n.grants > GRANT_SIGNALS.maxGrantsPerNetwork ? html`<span class="mark">${n.network}</span>` : n.network}</td>
              <td>${fmtNum(n.grants)}</td><td>${fmtNum(n.granted)}</td><td>${fmtNum(n.withheld)}</td><td>${fmtTime(n.last_at)}</td></tr>`,
          )}</table>`
        : html`<p class="muted">None.</p>`}

      <h2>Top trial spenders</h2>
      <p class="muted">Accounts that have never paid, by credits spent in the last 30 days.</p>
      ${d.spenders.length
        ? html`<table><tr><th>account</th><th>calls</th><th>credits spent</th><th>balance</th></tr>
          ${d.spenders.map(
            (s) => html`<tr><td><a href="/admin/accounts/${s.account_id}">${s.email}</a>${s.status === "suspended" ? html` <span class="label">suspended</span>` : ""}</td>
              <td>${fmtNum(s.calls)}</td><td>${fmtNum(s.credits)}</td><td>${fmtNum(s.balance)}</td></tr>`,
          )}</table>`
        : html`<p class="muted">None.</p>`}

      <h2>Alerts</h2>
      ${d.alerts.length
        ? html`<table><tr><th>sent</th><th>alert</th></tr>
          ${d.alerts.map((a) => html`<tr><td>${fmtTime(a.created_at)}</td><td>${a.subject ?? a.kind}</td></tr>`)}</table>`
        : html`<p class="muted">None yet.</p>`}

      <h2>Recent signals</h2>
      ${signalTable(d.signals, true)}`,
    );
  });

  // --- Free-credit requests -------------------------------------------------

  router.get("/requests", async (req, res) => {
    const { rows } = await db.query<{
      id: string; account_id: string; message: string | null; created_at: Date; email: string; email_domain: string;
      grant_status: string | null; grant_reason: string | null; network: string | null; blocked_list: string | null; allowed: boolean;
    }>(
      `SELECT r.id, r.account_id, r.message, r.created_at, a.email::text AS email, a.email_domain,
              g.status AS grant_status, g.reason AS grant_reason, g.ip_prefix::text AS network,
              (SELECT b.list FROM blocked_email_domains b WHERE b.domain = a.email_domain) AS blocked_list,
              EXISTS (SELECT 1 FROM allowed_email_domains d WHERE d.domain = a.email_domain) AS allowed
         FROM free_credit_requests r
         JOIN accounts a ON a.id = r.account_id
         LEFT JOIN free_grants g ON g.account_id = r.account_id
        WHERE r.status = 'pending' ORDER BY r.created_at LIMIT 100`,
    );
    const signals = rows.length
      ? (
          await db.query<{ account_id: string; kind: string; created_at: Date }>(
            `SELECT account_id, kind, created_at FROM abuse_signals WHERE account_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
            [rows.map((r) => r.account_id)],
          )
        ).rows
      : [];
    const csrf = csrfField(locals(res).csrf);
    await render(
      req,
      res,
      "Free-credit requests",
      html`<h1>Free-credit requests</h1>
      ${rows.length
        ? rows.map((r) => {
            const mine = signals.filter((s) => s.account_id === r.account_id);
            return html`<div class="notice">
              <p><a href="/admin/accounts/${r.account_id}"><b>${r.email}</b></a> <span class="muted">asked ${fmtTime(r.created_at)}</span></p>
              <p class="mono">domain ${r.email_domain}${r.blocked_list ? html` <span class="label">${r.blocked_list}</span>` : ""}${r.allowed ? html` <span class="label">allowed</span>` : ""}
                · grant ${r.grant_status ?? "none"}${r.grant_reason ? html` (${r.grant_reason})` : ""}${r.network ? html` · ${r.network}` : ""}</p>
              ${r.message ? html`<p>“${r.message}”</p>` : html`<p class="muted">No message.</p>`}
              <p class="muted">Signals: ${mine.length ? mine.map((s, i) => html`${i ? ", " : ""}${s.kind} (${fmtDate(s.created_at)})`) : "none"}</p>
              <div class="row">
                <form method="post" action="/admin/requests/${r.id}/approve">${csrf}
                  ${r.blocked_list || r.allowed
                    ? ""
                    : html`<label style="margin:0"><input type="checkbox" name="allow_domain" value="1" style="width:auto"> also allow ${r.email_domain} for future sign-ups</label>`}
                  <button>approve</button></form>
                <form method="post" action="/admin/requests/${r.id}/deny">${csrf}<button class="secondary">deny</button></form>
              </div></div>`;
          })
        : html`<p class="muted">No pending requests.</p>`}`,
    );
  });

  router.post("/requests/:id/approve", requireCsrf, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return notFound(req, res, "request");
    const by = adminEmail(res);
    const outcome = await withTransaction(db, async (c) => {
      const { rows } = await c.query<{ account_id: string; email_domain: string; blocked: boolean }>(
        `SELECT r.account_id, a.email_domain,
                EXISTS (SELECT 1 FROM blocked_email_domains b WHERE b.domain = a.email_domain) AS blocked
           FROM free_credit_requests r JOIN accounts a ON a.id = r.account_id
          WHERE r.id = $1 AND r.status = 'pending' FOR UPDATE OF r`,
        [id],
      );
      const r = rows[0];
      if (!r) return "not_pending" as const;
      const added = await grantFreeCredits(services, r.account_id, { status: "manual", by }, c);
      // Free-mail and disposable domains never go on the allowlist, whatever the form says.
      let allowed = false;
      if (req.body?.allow_domain === "1" && !r.blocked) {
        await c.query(
          `INSERT INTO allowed_email_domains (domain, approved_by, note) VALUES ($1, $2, 'Approved with a free-credit request')
           ON CONFLICT (domain) DO NOTHING`,
          [r.email_domain, by],
        );
        allowed = true;
      }
      await c.query(
        `UPDATE free_credit_requests SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [id, by],
      );
      if (!added) return "approved_no_credits" as const;
      return allowed ? ("approved_domain" as const) : ("approved" as const);
    });
    if (outcome === "approved" || outcome === "approved_domain") await notifyRequester(services, id, true);
    redirectWith(res, "/requests", outcome);
  });

  router.post("/requests/:id/deny", requireCsrf, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return notFound(req, res, "request");
    const { rowCount } = await db.query(
      `UPDATE free_credit_requests SET status = 'denied', reviewed_by = $2, reviewed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id, adminEmail(res)],
    );
    if (rowCount) await notifyRequester(services, id, false);
    redirectWith(res, "/requests", rowCount ? "denied" : "not_pending");
  });

  // --- Accounts -------------------------------------------------------------

  router.get("/accounts", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const { rows } = await db.query<{
      id: string; email: string; status: string; plan: string; first_paid_at: Date | null; created_at: Date; grant_status: string | null;
    }>(
      `SELECT a.id, a.email::text AS email, a.status, a.plan, a.first_paid_at, a.created_at, g.status AS grant_status
         FROM accounts a LEFT JOIN free_grants g ON g.account_id = a.id
        WHERE ($1::text IS NULL OR a.email::text ILIKE $1)
        ORDER BY a.created_at DESC LIMIT 50`,
      [pattern],
    );
    await render(
      req,
      res,
      "Accounts",
      html`<h1>Accounts</h1>
      <form method="get" action="/admin/accounts" class="row">
        <input name="q" value="${q}" placeholder="email contains…" aria-label="Email"><button>find</button></form>
      <p class="muted">${q ? `Matching “${q}”` : "Newest accounts"}, up to 50.</p>
      ${rows.length
        ? html`<table><tr><th>email</th><th>status</th><th>plan</th><th>grant</th><th>paid</th><th>joined</th></tr>
          ${rows.map(
            (a) => html`<tr><td><a href="/admin/accounts/${a.id}">${a.email}</a></td><td>${a.status}</td><td>${a.plan}</td>
              <td>${a.grant_status ?? ""}</td><td>${fmtDate(a.first_paid_at)}</td><td>${fmtDate(a.created_at)}</td></tr>`,
          )}</table>`
        : html`<p class="muted">No accounts.</p>`}`,
    );
  });

  router.get("/accounts/:id", async (req, res) => {
    const id = String(req.params.id);
    const account = UUID.test(id) ? await accounts.byId(id) : null;
    if (!account) return notFound(req, res, "account");
    const [balance, grant, keys, history, usage, signals] = await Promise.all([
      ledger.balance(id),
      db
        .query<{ status: string; reason: string | null; credits: number; ip: string | null; ip_prefix: string | null; fingerprint_hash: string | null; created_at: Date }>(
          `SELECT status, reason, credits, host(ip) AS ip, ip_prefix::text AS ip_prefix, fingerprint_hash, created_at
             FROM free_grants WHERE account_id = $1`,
          [id],
        )
        .then((r) => r.rows[0] ?? null),
      accounts.listKeys(id),
      ledger.history(id, 50),
      db
        .query<{ operation: string; calls: number; credits: number }>(
          `SELECT operation, count(*)::int AS calls, coalesce(sum(credits), 0)::int AS credits
             FROM usage_events WHERE account_id = $1 AND created_at > now() - interval '30 days'
            GROUP BY operation ORDER BY credits DESC, calls DESC`,
          [id],
        )
        .then((r) => r.rows),
      recentSignals(db, { accountId: id, limit: 50 }),
    ]);
    const csrf = csrfField(locals(res).csrf);
    const suspended = account.status === "suspended";
    await render(
      req,
      res,
      account.email,
      html`<h1>${account.email}</h1>
      <table>
        <tr><th>status</th><td>${suspended ? html`<span class="mark">suspended</span> ${account.suspended_reason ?? ""}` : account.status}</td></tr>
        <tr><th>plan</th><td>${account.plan}${account.plan_status ? ` (${account.plan_status})` : ""}${account.plan_renews_at ? `, renews ${fmtDate(account.plan_renews_at)}` : ""}</td></tr>
        <tr><th>first paid</th><td>${account.first_paid_at ? fmtDate(account.first_paid_at) : "never (trial caps)"}</td></tr>
        <tr><th>joined</th><td>${fmtDate(account.created_at)}, verified ${account.email_verified_at ? fmtDate(account.email_verified_at) : "no"}</td></tr>
        <tr><th>free grant</th><td>${grant
          ? html`${grant.status}${grant.reason ? ` (${grant.reason})` : ""}, ${fmtNum(grant.credits)} credits, ${fmtDate(grant.created_at)}
            <br><span class="mono muted">${grant.ip ?? ""} ${grant.ip_prefix ?? ""} ${grant.fingerprint_hash ? `fp ${grant.fingerprint_hash.slice(0, 12)}` : ""}</span>`
          : "none"}</td></tr>
      </table>

      <div class="stats">
        <div class="stat"><span class="label">total</span><b>${fmtNum(balance.total)}</b></div>
        <div class="stat"><span class="label">trial</span><b>${fmtNum(balance.trial)}</b></div>
        <div class="stat"><span class="label">plan</span><b>${fmtNum(balance.plan)}</b></div>
        <div class="stat"><span class="label">top-up</span><b>${fmtNum(balance.topup)}</b></div>
      </div>

      <h2>Actions</h2>
      <form method="post" action="/admin/accounts/${id}/revoke">${csrf}
        <label for="reason">Revoke: zero the unspent trial credits, revoke every API key and suspend the account</label>
        <input id="reason" name="reason" required maxlength="500" placeholder="reason, e.g. farming free grants">
        <button>revoke and suspend</button></form>
      ${suspended
        ? html`<form method="post" action="/admin/accounts/${id}/unsuspend">${csrf}<button class="secondary">reactivate account</button></form>`
        : ""}
      <form method="post" action="/admin/accounts/${id}/credits">${csrf}
        <label for="credits">Add credits by hand (top-up bucket, no expiry)</label>
        <div class="row"><input id="credits" name="credits" inputmode="numeric" pattern="[0-9]*" required placeholder="credits">
          <input name="note" required maxlength="500" placeholder="note" aria-label="Note"><button>add credits</button></div></form>

      <h2>API keys</h2>
      ${keys.length
        ? html`<table><tr><th>name</th><th>prefix</th><th>cap</th><th>last used</th><th>state</th></tr>
          ${keys.map(
            (k) => html`<tr><td>${k.name}</td><td class="mono">${k.prefix}…</td><td>${k.monthly_credit_cap === null ? "" : fmtNum(k.monthly_credit_cap)}</td>
              <td>${fmtDate(k.last_used_at)}</td><td>${k.revoked_at ? `revoked ${fmtDate(k.revoked_at)}` : "active"}</td></tr>`,
          )}</table>`
        : html`<p class="muted">No keys.</p>`}

      <h2>Usage, last 30 days</h2>
      ${usage.length
        ? html`<table><tr><th>operation</th><th>calls</th><th>credits</th></tr>
          ${usage.map((u) => html`<tr><td class="mono">${u.operation}</td><td>${fmtNum(u.calls)}</td><td>${fmtNum(u.credits)}</td></tr>`)}</table>`
        : html`<p class="muted">No calls.</p>`}

      <h2>Ledger</h2>
      ${history.length
        ? html`<table><tr><th>when</th><th>kind</th><th>amount</th><th>ref / note</th><th>by</th></tr>
          ${history.map(
            (h) => html`<tr><td>${fmtTime(h.created_at)}</td><td>${h.kind}</td><td class="mono">${h.amount > 0 ? "+" : ""}${fmtNum(h.amount)}</td>
              <td class="mono">${h.ref ?? ""}${h.ref && h.note ? " · " : ""}${h.note ?? ""}</td><td>${h.created_by}</td></tr>`,
          )}</table>`
        : html`<p class="muted">No ledger rows.</p>`}

      <h2>Abuse signals</h2>
      ${signalTable(signals, false)}`,
    );
  });

  /** The spec's one admin action: revoke unspent grant credits and suspend the account's keys, atomically. */
  router.post("/accounts/:id/revoke", requireCsrf, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id) || !(await accounts.byId(id))) return notFound(req, res, "account");
    const reason = z.string().trim().min(1).max(500).safeParse(req.body?.reason);
    if (!reason.success) return redirectWith(res, `/accounts/${id}`, "invalid_reason");
    const by = adminEmail(res);
    const cleared = await withTransaction(db, async (c) => {
      const n = await ledger.clearBucket(id, "revoke", { bucket: "trial", note: reason.data, createdBy: by }, c);
      await c.query(`UPDATE free_grants SET status = 'revoked' WHERE account_id = $1`, [id]);
      await accounts.revokeAllKeys(id, c);
      await accounts.setSuspended(id, true, reason.data, c);
      return n;
    });
    redirectWith(res, `/accounts/${id}`, "revoked", cleared);
  });

  router.post("/accounts/:id/unsuspend", requireCsrf, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id) || !(await accounts.byId(id))) return notFound(req, res, "account");
    await accounts.setSuspended(id, false, null);
    redirectWith(res, `/accounts/${id}`, "unsuspended");
  });

  const creditsForm = z.object({
    credits: z.string().trim().regex(/^\d{1,7}$/).transform(Number).pipe(z.number().int().min(1).max(1_000_000)),
    note: z.string().trim().min(1).max(500),
  });

  router.post("/accounts/:id/credits", requireCsrf, async (req, res) => {
    const id = String(req.params.id);
    if (!UUID.test(id) || !(await accounts.byId(id))) return notFound(req, res, "account");
    const form = creditsForm.safeParse(req.body ?? {});
    if (!form.success) return redirectWith(res, `/accounts/${id}`, "invalid_credits");
    await ledger.addLot({
      accountId: id,
      bucket: "topup",
      kind: "adjust",
      credits: form.data.credits,
      expiresAt: null,
      ref: null,
      note: form.data.note,
      createdBy: adminEmail(res),
    });
    redirectWith(res, `/accounts/${id}`, "credits_added", form.data.credits);
  });

  // --- Domain allowlist -----------------------------------------------------

  router.get("/domains", async (req, res) => {
    const { rows } = await db.query<{ domain: string; approved_by: string; note: string | null; created_at: Date }>(
      `SELECT domain, approved_by, note, created_at FROM allowed_email_domains ORDER BY created_at DESC, domain`,
    );
    const csrf = csrfField(locals(res).csrf);
    await render(
      req,
      res,
      "Allowed domains",
      html`<h1>Allowed domains</h1>
      <p class="muted">Domains here pass the work-email check for the free grant, even when a list flags them.</p>
      <form method="post" action="/admin/domains">${csrf}
        <div class="row"><input name="domain" required placeholder="example.com" aria-label="Domain">
          <input name="note" maxlength="500" placeholder="note (optional)" aria-label="Note"><button>add</button></div></form>
      ${rows.length
        ? html`<table><tr><th>domain</th><th>approved by</th><th>note</th><th>added</th><th></th></tr>
          ${rows.map(
            (d) => html`<tr><td class="mono">${d.domain}</td><td>${d.approved_by}</td><td>${d.note ?? ""}</td><td>${fmtDate(d.created_at)}</td>
              <td><form method="post" action="/admin/domains/${encodeURIComponent(d.domain)}/delete">${csrf}<button class="secondary small">remove</button></form></td></tr>`,
          )}</table>`
        : html`<p class="muted">None yet.</p>`}`,
    );
  });

  router.post("/domains", requireCsrf, async (req, res) => {
    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return redirectWith(res, "/domains", "invalid_domain");
    const blocked = await db.query(`SELECT 1 FROM blocked_email_domains WHERE domain = $1`, [domain]);
    if (blocked.rowCount) return redirectWith(res, "/domains", "domain_blocked");
    const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null;
    const { rowCount } = await db.query(
      `INSERT INTO allowed_email_domains (domain, approved_by, note) VALUES ($1, $2, $3) ON CONFLICT (domain) DO NOTHING`,
      [domain, adminEmail(res), note],
    );
    redirectWith(res, "/domains", rowCount ? "domain_added" : "domain_exists");
  });

  router.post("/domains/:domain/delete", requireCsrf, async (req, res) => {
    await db.query(`DELETE FROM allowed_email_domains WHERE domain = $1`, [String(req.params.domain).toLowerCase()]);
    redirectWith(res, "/domains", "domain_removed");
  });

  return router;
}

function signalTable(signals: SignalRow[], withAccount: boolean): Html {
  if (!signals.length) return html`<p class="muted">None.</p>`;
  return html`<table><tr><th>when</th><th>kind</th>${withAccount ? html`<th>account</th>` : ""}<th>network</th><th>domain</th><th>detail</th></tr>
    ${signals.map(
      (s) => html`<tr><td>${fmtTime(s.created_at)}</td><td class="mono">${s.kind}</td>
        ${withAccount ? html`<td>${s.account_id ? html`<a href="/admin/accounts/${s.account_id}">${s.email ?? s.account_id}</a>` : ""}</td>` : ""}
        <td class="mono">${s.ip_prefix ?? s.ip ?? ""}</td><td>${s.email_domain ?? ""}</td>
        <td class="mono">${Object.keys(s.detail ?? {}).length ? short(s.detail) : ""}</td></tr>`,
    )}</table>`;
}

/** Tells the person who asked for free credits what was decided (the request page promises an email). */
async function notifyRequester(services: Services, requestId: string, approved: boolean): Promise<void> {
  const { rows } = await services.db.query<{ email: string }>(
    `SELECT a.email FROM free_credit_requests r JOIN accounts a ON a.id = r.account_id WHERE r.id = $1`,
    [requestId],
  );
  const to = rows[0]?.email;
  if (!to) return;
  const account = `${services.config.PUBLIC_BASE_URL}/account`;
  await services.mailer
    .send({
      to,
      template: approved ? "creditsApproved" : "creditsDenied",
      data: approved ? { credits: FREE_GRANT.credits, accountUrl: account } : { accountUrl: account },
      subject: approved ? "Your WhichSitesUse free credits are in" : "About your WhichSitesUse free credit request",
      text: approved
        ? `Hi,\n\nThanks for the details. We've added ${FREE_GRANT.credits} free credits to your account:\n\n${account}\n`
        : `Hi,\n\nThanks for asking. We couldn't add free credits to this account, but you can still buy credits any time:\n\n${account}\n`,
    })
    .catch((err: unknown) => log.warn({ err }, "request decision email not sent"));
}
