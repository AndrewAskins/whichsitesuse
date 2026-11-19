import { Router, type Request, type Response } from "express";
import { recordSignal } from "../abuse/alerts.js";
import { RateLimiter } from "../abuse/rateLimit.js";
import { parseEmail } from "../auth/email.js";
import { emailDomainStatus } from "../auth/emailLists.js";
import { decideFreeGrant } from "../auth/freeGrant.js";
import { consumeMagicLink, magicLinkValid, sendMagicLink } from "../auth/magicLinks.js";
import { hmac } from "../auth/tokens.js";
import { turnstileEnabled, verifyTurnstile } from "../auth/turnstile.js";
import { FREE_GRANT } from "../billing/plans.js";
import { adminEmails, sessionSecret } from "../config.js";
import { isUniqueViolation } from "../db/pool.js";
import { log } from "../log.js";
import type { Services } from "../services.js";
import { csrfField, html, notice, page, raw, type Html } from "./layout.js";
import { endSession, locals, requireAccount, requireCsrf, startSession } from "./session.js";

/** Sign-up and sign-in emails per IP per hour, so the forms can't be used to spam inboxes. */
const EMAILS_PER_IP_PER_HOUR = 10;

/**
 * A rough browser fingerprint, hashed in the browser. It only needs to be
 * stable enough to spot the same device making a second account; the server
 * HMACs it again before storing.
 */
const FINGERPRINT_SCRIPT = raw(`<script>
(async () => {
  try {
    const c = document.createElement("canvas"); const x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "14px Arial"; x.fillText("whichsitesuse 🧙", 2, 2);
    const parts = [navigator.userAgent, navigator.language, (navigator.languages || []).join(","), screen.width + "x" + screen.height,
      screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.platform, c.toDataURL()];
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    document.querySelectorAll("input[name=fp]").forEach((i) => (i.value = hex));
  } catch (e) {}
})();
</script>`);

export function signupRoutes(services: Services): Router {
  const router = Router();
  const config = services.config;
  const emailLimiter = new RateLimiter(3600_000);
  const turnstileHead = turnstileEnabled(config)
    ? raw(`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`)
    : undefined;
  const turnstileWidget = turnstileEnabled(config)
    ? html`<div class="cf-turnstile" data-sitekey="${config.TURNSTILE_SITE_KEY}" style="margin-top:16px"></div>`
    : html``;

  const signupPage = (res: Response, error?: string, email = "", next = "") =>
    res.status(error ? 400 : 200).send(
      page({
        title: "Sign up",
        head: turnstileHead,
        body: html`<h1>Get an <span class="mark">API key</span></h1>
<p>Verified work emails get ${FREE_GRANT.credits} free credits, once. Any email can buy credits.</p>
${notice(error)}
<form method="post" action="/signup">${csrfField(locals(res).csrf)}<input type="hidden" name="fp" value=""><input type="hidden" name="next" value="${next}">
<label for="email" class="label">Email</label>
<input id="email" name="email" type="email" required autocomplete="email" value="${email}" placeholder="you@company.com">
${turnstileWidget}
<button>email me a link</button></form>
<p class="muted">Already signed up? <a href="${withNext("/login", next)}">Sign in</a>.</p>${FINGERPRINT_SCRIPT}`,
      }),
    );

  const checkInbox = (res: Response, email: string) =>
    res.send(
      page({
        title: "Check your inbox",
        body: html`<h1>Check your <span class="mark">inbox</span></h1>
<p>If <b>${email}</b> can sign in, a link is on its way. It works once.</p>
<p class="muted">Nothing after a few minutes? Check spam, or <a href="/login">send another</a>.</p>`,
      }),
    );

  const limited = (req: Request) => emailLimiter.hit(`email:${req.ip}`, EMAILS_PER_IP_PER_HOUR) > 0;

  router.get("/signup", (req, res) => {
    const next = safeNext(req.query.next);
    if (locals(res).account) return res.redirect(303, next ?? "/account");
    signupPage(res, undefined, "", next ?? "");
  });

  router.post("/signup", requireCsrf, async (req, res) => {
    const rawEmail = String(req.body.email ?? "");
    const next = safeNext(req.body.next);
    const parsed = parseEmail(rawEmail);
    if (!parsed) return signupPage(res, "That doesn't look like an email address.", rawEmail, next ?? "");
    if (limited(req)) return signupPage(res, "Too many sign-ups from this network. Try again in an hour.", rawEmail, next ?? "");

    if (!(await verifyTurnstile(config, String(req.body["cf-turnstile-response"] ?? "") || undefined, req.ip))) {
      await recordSignal(services, { kind: "turnstile_failed", ip: req.ip, emailDomain: parsed.domain });
      return signupPage(res, "The bot check didn't pass. Reload the page and try again.", rawEmail, next ?? "");
    }
    const status = await emailDomainStatus(services, parsed.domain);
    if (status === "disposable") {
      await recordSignal(services, { kind: "disposable_signup", ip: req.ip, emailDomain: parsed.domain });
      return signupPage(res, "Disposable email addresses can't sign up. Use your work email.", rawEmail, next ?? "");
    }

    // The same inbox (dots and +tags aside) is the same account: send it a sign-in link instead.
    let account = await services.accounts.byNormalizedEmail(parsed.normalized);
    if (!account) {
      const fp = typeof req.body.fp === "string" && /^[0-9a-f]{64}$/.test(req.body.fp) ? req.body.fp : null;
      try {
        account = await services.accounts.create({
          ...parsed,
          ip: req.ip ?? null,
          fingerprintHash: fp ? hmac(sessionSecret(config), `fp:${fp}`) : null,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        account = await services.accounts.byNormalizedEmail(parsed.normalized);
      }
    }
    if (account) await sendMagicLink(services, account, next);
    checkInbox(res, parsed.email);
  });

  router.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    if (locals(res).account) return res.redirect(303, next ?? "/account");
    res.send(
      page({
        title: "Sign in",
        body: html`<h1>Sign <span class="mark">in</span></h1>
<form method="post" action="/login">${csrfField(locals(res).csrf)}<input type="hidden" name="next" value="${next ?? ""}">
<label for="email" class="label">Email</label>
<input id="email" name="email" type="email" required autocomplete="email">
<button>email me a link</button></form>
<p class="muted">New here? <a href="${withNext("/signup", next ?? "")}">Sign up</a>.</p>`,
      }),
    );
  });

  router.post("/login", requireCsrf, async (req, res) => {
    const parsed = parseEmail(String(req.body.email ?? ""));
    if (!parsed) return res.redirect(303, "/login");
    if (!limited(req)) {
      const account = await services.accounts.byNormalizedEmail(parsed.normalized);
      // Same answer either way, so the form doesn't reveal who has an account.
      if (account) await sendMagicLink(services, account, safeNext(req.body.next));
    }
    checkInbox(res, parsed.email);
  });

  // Mail scanners open links, so GET only shows a button; the POST uses the link.
  router.get("/auth/:token", async (req, res) => {
    const valid = await magicLinkValid(services, String(req.params.token));
    res.status(valid ? 200 : 400).send(
      page({
        title: "Sign in",
        body: valid
          ? html`<h1>One <span class="mark">click</span> left</h1>
<form method="post" action="${withNext(`/auth/${String(req.params.token)}`, safeNext(req.query.next) ?? "")}">${csrfField(locals(res).csrf)}<button>continue to whichsitesuse</button></form>`
          : expiredLink(),
      }),
    );
  });

  router.post("/auth/:token", requireCsrf, async (req, res) => {
    const used = await consumeMagicLink(services, String(req.params.token));
    if (!used) return res.status(400).send(page({ title: "Link expired", body: expiredLink() }));
    let account = await services.accounts.byId(used.accountId);
    if (!account) return res.status(400).send(page({ title: "Link expired", body: expiredLink() }));
    let welcome = "";
    if (!account.email_verified_at) {
      account = await services.accounts.markVerified(account.id, adminEmails(config).has(account.email.toLowerCase()));
      try {
        const decision = await decideFreeGrant(services, account);
        welcome = decision.status === "granted" ? "granted" : "withheld";
      } catch (err) {
        log.error({ err, account: account.id }, "free grant check failed");
      }
    }
    await startSession(services, res, account.id);
    // Someone connecting an app (OAuth) goes straight back to it.
    const next = safeNext(req.query.next);
    res.redirect(303, next ?? (welcome ? `/account?welcome=${welcome}` : "/account"));
  });

  router.post("/logout", async (req, res) => {
    await endSession(services, req, res);
    res.redirect(303, "/login");
  });

  // The "request free credits" form for people the work-email check turned away.
  router.get("/request-credits", requireAccount, async (_req, res) => {
    const account = locals(res).account!;
    const pending = await services.db.query(
      `SELECT 1 FROM free_credit_requests WHERE account_id = $1 AND status = 'pending'`,
      [account.id],
    );
    res.send(
      page({
        title: "Request free credits",
        signedIn: true,
        isAdmin: account.is_admin,
        body: requestForm(locals(res).csrf, Boolean(pending.rowCount)),
      }),
    );
  });

  router.post("/request-credits", requireAccount, requireCsrf, async (req, res) => {
    const account = locals(res).account!;
    const message = String(req.body.message ?? "").trim().slice(0, 2000);
    await services.db
      .query(`INSERT INTO free_credit_requests (account_id, message) VALUES ($1, $2)`, [account.id, message || null])
      .catch((err: unknown) => {
        if (!isUniqueViolation(err)) throw err;
      });
    res.redirect(303, "/account?requested=1");
  });

  return router;
}

function expiredLink(): Html {
  return html`<h1>That link has <span class="mark">expired</span></h1>
<p>Links work once and don't last long. <a href="/login">Send a new one</a>.</p>`;
}

function requestForm(csrf: string, pending: boolean): Html {
  if (pending) {
    return html`<h1>Request <span class="mark">sent</span></h1><p>We'll look at it soon and email you when it's done.</p>`;
  }
  return html`<h1>Request <span class="mark">free credits</span></h1>
<p>Free credits go to verified work emails, once per person. If you run a small company or work freelance and the
check got it wrong, tell us who you are and what you'll use WhichSitesUse for. A person reads every request.</p>
<form method="post" action="/request-credits">${csrfField(csrf)}
<label for="message" class="label">About you</label>
<textarea id="message" name="message" maxlength="2000" required placeholder="Your company or site, and what you're building"></textarea>
<button>send request</button></form>`;
}

/** A same-site path to return to after signing in, or null. Never another host. */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.length > 4000 || /[\r\n]/.test(value)) return null;
  return value;
}

function withNext(path: string, next: string): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
