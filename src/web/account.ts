import { Router, type Response } from "express";
import { isTrial, type ApiKey } from "../auth/accounts.js";
import { currentGrant, type GrantDecision } from "../auth/freeGrant.js";
import { PLANS, TOPUP, TRIAL_CAPS, formatUsd } from "../billing/plans.js";
import type { Services } from "../services.js";
import { csrfField, fmtDate, fmtNum, html, notice, page, type Html } from "./layout.js";
import { locals, requireAccount, requireCsrf } from "./session.js";

const WELCOME: Record<string, string> = {
  granted: "You're verified, and your free credits are in. Create an API key below to start.",
  withheld: "You're verified. Free credits didn't apply to this account (see below), but you can buy credits any time.",
};

const WITHHELD: Record<string, string> = {
  not_work_email: "Free credits go to work email addresses, and this one looks like a personal or generic address.",
  already_granted: "This inbox already had free credits on another account.",
  network: "Several accounts from your network got free credits this week, so this one's held until a first purchase.",
  device: "This device already got free credits on another account, so this one's held until a first purchase.",
};

export function accountRoutes(services: Services): Router {
  const router = Router();

  const render = async (res: Response, opts: { message?: string; newKey?: { name: string; secret: string } } = {}) => {
    const account = locals(res).account!;
    const [balance, keys, grant, ledger] = await Promise.all([
      services.ledger.balance(account.id),
      services.accounts.listKeys(account.id),
      currentGrant(services, account.id),
      services.ledger.history(account.id, 15),
    ]);
    const used = new Map(
      await Promise.all(keys.map(async (k) => [k.id, await services.accounts.keyCreditsThisMonth(k.id)] as const)),
    );
    const csrf = locals(res).csrf;
    const base = services.config.PUBLIC_BASE_URL;

    res.send(
      page({
        title: "Account",
        signedIn: true,
        isAdmin: account.is_admin,
        body: html`<h1><span class="mark">${fmtNum(balance.total)}</span> credits</h1>
<p class="muted">${account.email} · ${account.plan === "none" ? "no plan" : `${PLANS[account.plan].name} plan`}${
          account.plan_renews_at ? ` · renews ${fmtDate(account.plan_renews_at)}` : ""
        }</p>
${notice(opts.message, "ok")}
${opts.newKey ? newKeyNotice(opts.newKey) : ""}
<div class="stats">
  <div class="stat"><span class="label">Plan credits</span><b>${fmtNum(balance.plan)}</b>${
    balance.plan_expires_at ? html`<span class="muted">reset ${fmtDate(balance.plan_expires_at)}</span>` : ""
  }</div>
  <div class="stat"><span class="label">Top-up credits</span><b>${fmtNum(balance.topup)}</b><span class="muted">last 12 months</span></div>
  <div class="stat"><span class="label">Free credits</span><b>${fmtNum(balance.trial)}</b></div>
</div>
${grantNotice(grant)}
${isTrial(account) ? html`<p class="muted">Until your first purchase, calls return up to ${TRIAL_CAPS.maxResultsPerCall} results, ${TRIAL_CAPS.callsPerMinute} calls a minute, with no CSV export.</p>` : ""}

<h2>API keys</h2>
<p>Use a key with the MCP server at <code>${base}/mcp</code> or the REST API at <code>${base}/v1</code>, sent as <code>Authorization: Bearer &lt;key&gt;</code>. A monthly cap stops a key (and any agent using it) from spending more than you allow.</p>
${keys.length ? keysTable(keys, used, csrf) : html`<p class="muted">No keys yet.</p>`}
<form method="post" action="/account/keys" class="row">${csrfField(csrf)}
  <div><label for="name" class="label">Name</label><input id="name" name="name" maxlength="60" placeholder="claude desktop" required></div>
  <div><label for="cap" class="label">Monthly cap (optional)</label><input id="cap" name="cap" type="number" min="0" placeholder="no cap"></div>
  <button>create key</button>
</form>

<h2>Buy credits</h2>
${account.stripe_subscription_id && account.plan !== "none" ? html`<p><a class="button secondary" href="/account/billing">change or cancel plan</a></p>` : ""}
<table><tr><th>Plan</th><th>Price</th><th>Credits a month</th><th></th></tr>
${Object.values(PLANS).map(
  (p) => html`<tr><td>${p.name}</td><td>${formatUsd(p.priceCents)}/mo</td><td>${fmtNum(p.monthlyCredits)}</td><td>${
    account.plan === p.id
      ? html`<span class="label">current</span>`
      : html`<form method="post" action="/account/buy">${csrfField(csrf)}<input type="hidden" name="item" value="${p.id}"><button class="small">${account.plan === "none" ? "subscribe" : "switch"}</button></form>`
  }</td></tr>`,
)}</table>
<form method="post" action="/account/buy" class="row">${csrfField(csrf)}<input type="hidden" name="item" value="topup">
  <div><label for="units" class="label">Top-up (${formatUsd(TOPUP.priceCentsPerUnit)} per ${fmtNum(TOPUP.creditsPerUnit)}, lasts 12 months)</label>
  <select id="units" name="units">${[1, 2, 5, 10, 25].map((u) => html`<option value="${u}">${fmtNum(u * TOPUP.creditsPerUnit)} credits, ${formatUsd(u * TOPUP.priceCentsPerUnit)}</option>`)}</select></div>
  <button class="secondary">buy top-up</button>
</form>
${account.stripe_customer_id ? html`<p><a href="/account/billing">Invoices and payment details</a></p>` : ""}

<h2>Recent activity</h2>
${ledger.length
  ? html`<table><tr><th>Date</th><th>What</th><th>Credits</th></tr>${ledger.map(
      (r) => html`<tr><td>${fmtDate(r.created_at)}</td><td>${r.note ?? r.kind}</td><td class="mono">${r.amount > 0 ? "+" : ""}${fmtNum(r.amount)}</td></tr>`,
    )}</table>`
  : html`<p class="muted">Nothing yet.</p>`}`,
      }),
    );
  };

  router.get("/account", requireAccount, async (req, res) => {
    const q = req.query;
    const message =
      typeof q.welcome === "string" ? WELCOME[q.welcome]
      : q.paid ? "Payment received. Credits appear here as soon as Stripe confirms it, usually within seconds."
      : q.requested ? "Request sent. We'll email you when it's reviewed."
      : typeof q.msg === "string" ? q.msg.slice(0, 200)
      : undefined;
    await render(res, { message });
  });

  router.post("/account/keys", requireAccount, requireCsrf, async (req, res) => {
    const account = locals(res).account!;
    if (account.status === "suspended") return render(res, { message: "This account is suspended, so it can't create keys." });
    const name = String(req.body.name ?? "").trim().slice(0, 60) || "key";
    const cap = parseCap(req.body.cap);
    const { secret } = await services.accounts.createKey(account.id, name, cap);
    // Rendered directly (not redirected) so the secret is shown once and never stored.
    await render(res, { newKey: { name, secret } });
  });

  router.post("/account/keys/:id/revoke", requireAccount, requireCsrf, async (req, res) => {
    await services.accounts.revokeKey(locals(res).account!.id, req.params.id as string);
    res.redirect(303, "/account?msg=Key%20revoked.");
  });

  router.post("/account/keys/:id/cap", requireAccount, requireCsrf, async (req, res) => {
    await services.accounts.setKeyCap(locals(res).account!.id, req.params.id as string, parseCap(req.body.cap));
    res.redirect(303, "/account?msg=Cap%20saved.");
  });

  return router;
}

function parseCap(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function newKeyNotice(key: { name: string; secret: string }): Html {
  return html`<div class="notice"><p class="label">New key: ${key.name}</p><p class="secret">${key.secret}</p>
<p class="muted">Copy it now. It won't be shown again.</p></div>`;
}

function grantNotice(grant: GrantDecision | null): Html {
  if (!grant || grant.status !== "withheld") return html``;
  const why = WITHHELD[grant.reason] ?? "Free credits didn't apply to this account.";
  const appeal = grant.reason === "not_work_email" || grant.reason === "already_granted";
  return html`<div class="notice">${why} ${appeal ? html`If that's wrong, <a href="/request-credits">request free credits</a>.` : ""}</div>`;
}

function keysTable(keys: ApiKey[], used: Map<string, number>, csrf: string): Html {
  return html`<table><tr><th>Name</th><th>Key</th><th>Used this month</th><th>Monthly cap</th><th>Last used</th><th></th></tr>
${keys.map((k) =>
  k.revoked_at
    ? html`<tr class="muted"><td>${k.name}</td><td class="mono">${k.prefix}…</td><td>${fmtNum(used.get(k.id))}</td><td></td><td>${fmtDate(k.last_used_at)}</td><td>revoked ${fmtDate(k.revoked_at)}</td></tr>`
    : html`<tr><td>${k.name}</td><td class="mono">${k.oauth_client_id ? "connected app" : `${k.prefix}…`}</td><td>${fmtNum(used.get(k.id))}</td>
<td><form method="post" action="/account/keys/${k.id}/cap" class="row">${csrfField(csrf)}<input name="cap" type="number" min="0" value="${k.monthly_credit_cap ?? ""}" placeholder="none" style="width:100px"><button class="small secondary">save</button></form></td>
<td>${fmtDate(k.last_used_at) || "never"}</td>
<td><form method="post" action="/account/keys/${k.id}/revoke">${csrfField(csrf)}<button class="small secondary">${k.oauth_client_id ? "disconnect" : "revoke"}</button></form></td></tr>`,
)}</table>`;
}
