# WhichSitesUse

Website technology lookup for agents: an MCP server and REST API that answer
"which sites use technology X" and "what does domain Y run", built on a
monthly snapshot of [HTTP Archive](https://httparchive.org)'s public crawl.

The product spec (scope, credits, abuse controls, brand, build plan) lives in
Notion and is the source of truth; this README only covers the code.

## How it fits together

```
BigQuery (httparchive.crawl.pages + CrUX)      monthly cron: src/pipeline
        │  extract.sql, one partition, no Lighthouse/payload columns
        ▼
Parquet snapshot (technologies, sites, site_tech + manifest)  ──► Cloudflare R2
        │
        ▼
Query service (src/index.ts, one Render web service)
   ├── DuckDB over the Parquet files (src/data/snapshot.ts), kill switch in the views
   ├── operations (src/operations): one definition per tool
   ├── /mcp   MCP Streamable HTTP, stateless
   └── /v1/*  REST, same operations, same envelope
Postgres (src/db/migrations): accounts, keys, credit lots + ledger, usage, abuse signals, technology overrides
```

Every operation is defined once in `src/operations` (name, agent-facing
description, zod input, REST route, handler) and exposed through both MCP and
REST, so the two can't drift. Every response carries `meta.crawl_date`,
`meta.credits_used`, `meta.credits_remaining` and `meta.attribution`.

## Tools

| Tool | REST | Cost |
| --- | --- | --- |
| `find_technologies` | `GET /v1/technologies?q=` | free |
| `count_sites` | `GET /v1/counts` | free |
| `search_sites` | `GET /v1/sites` | 1 credit per site returned (`max_credits` caps it) |
| `lookup_domain` | `GET /v1/domains/:domain` | 2 credits; free when the domain isn't covered |
| `get_balance` | `GET /v1/balance` | free (signed in) |
| `buy_credits` | `POST /v1/checkout` | free (signed in); returns a checkout link a human pays |

`count_sites` and `search_sites` share one filter (`src/operations/siteFilters.ts`).
REST takes lists as `technologies=shopify,klaviyo` or repeated params, and CWV as `cwv=lcp:pass,cls:fail`.

## Accounts, credits and billing

- **Sign-up** (`src/web/signup.ts`): magic links only, no passwords. Disposable domains are refused;
  credits arrive only once the link is clicked. Cloudflare Turnstile runs on the form when its keys are set.
- **Free grant** (`src/auth/freeGrant.ts`): 250 credits, once per person, decided at verification.
  Withheld for non-work emails (they can still pay, and can use `/request-credits`), an inbox that already
  had one, a repeat device fingerprint, or a third grant from one /24 in a week. Device and network holds
  lift on the first payment.
- **Credits** (`src/billing/ledger.ts`): lots per bucket (plan, top-up, trial) with their own expiry, and
  an append-only ledger. Plan credits are spent first, then top-ups, then the free grant. Prices, plans and
  costs live only in `src/billing/plans.ts`.
- **The gate** (`src/http/gate.ts`): every MCP and REST call goes through it. It authenticates the API key,
  rate-limits, builds `ctx.billing` (what the call may spend after balance, the key's monthly cap and
  `max_credits`; trial caps for accounts that have never paid), runs the operation, then charges its
  `credits_used` with a usage event. Paid operations set `pricing: "paid"` and call
  `ctx.billing.require(n)`; the 402 `insufficient_credits` error carries checkout links.
- **Stripe** (`src/billing/stripe.ts`, `webhooks.ts`, `src/web/buy.ts`): Checkout for plans and top-ups,
  webhooks at `POST /stripe/webhook` into the ledger. Prices are found or created by lookup key, so there
  is no price id to configure. `buy_credits` returns a signed `/buy/<token>` link a human opens; it lasts 7 days.
  The webhook endpoint in Stripe needs these events: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `invoice.paid`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `charge.refunded` and `charge.dispute.created`. A refund takes back the same
  share of the credits it bought, from what's left (the admin gets an alert when some were already spent); a
  dispute takes back all of them and suspends the account. A late invoice for an earlier period never resets
  this month's credits, a mid-month upgrade adds only the extra credits for the days left, and a second
  subscription on one account adds nothing and alerts the admin. Pages can't be framed.
- **OAuth for MCP clients** (`src/auth/oauth.ts`, `src/web/oauth.ts`): what Claude, ChatGPT and other
  directories expect. Protected-resource and authorization-server metadata under `/.well-known/`, dynamic
  client registration (`/oauth/register`), authorization code with PKCE S256 (`/oauth/authorize`, a consent
  page with an optional monthly credit cap), `/oauth/token` with rotating refresh tokens, and `/oauth/revoke`.
  An approved app is stored as an `api_keys` row, so caps, usage and revocation work as for keys. With
  accounts on, `/mcp` answers 401 with `WWW-Authenticate` until it gets an OAuth token or API key; REST free
  tools stay anonymous.
- **Pages**: `/signup`, `/login`, `/account` (balance, API keys and caps, buy), `/request-credits`, `/admin`
  (abuse dashboard, request review, revoke and suspend). Accounts in `ADMIN_EMAILS` become admins when they verify.
- **Email** (`src/mail/mailer.ts`): Loops transactional emails. Without `LOOPS_API_KEY` (or a template's id)
  the email is written to the log instead. The five templates, their env vars, data variables and copy are in
  [docs/emails.md](docs/emails.md).
- Background jobs run in the web service (`src/jobs.ts`): hourly credit expiry, weekly email-list refresh.

## Running locally

```sh
npm install
cp .env.example .env
npm run dev            # http://localhost:3000/health, /v1/technologies?q=shopify, POST /mcp
npm test               # set TEST_DATABASE_URL to also run the migration test
```

Without a snapshot on disk the data tools answer `snapshot_unavailable` (HTTP 503).

## Pipeline

`node dist/pipeline/cli.js <mode>` (or `PIPELINE_MODE`):

- `dry-run` reports the bytes the extract would scan and whether it fits the free tier. Free.
- `measure` runs an aggregate-only version of the extract: rows, sites, average detections per site, and a size estimate. Scans the same bytes as the extract.
- `monthly` runs `EXPORT DATA` to `gs://$GCS_BUCKET/extract/<month>/`, downloads the files, builds the snapshot with DuckDB (`src/pipeline/transform.ts`: technology overrides from Postgres applied, `first_seen` carried from last month), uploads it to R2 under `snapshots/<month>/`, then rewrites `snapshots/current.json`. It skips a month that is already current unless `CRAWL_DATE` pins one. Last, it publishes the SEO dataset (below).
- `seo` rebuilds the SEO dataset from the snapshot already on R2. No BigQuery. Use it after a failed SEO step, or after changing `src/seo/dataset.ts`.

The query service (`src/data/sync.ts`) downloads the month `current.json` points at into its own directory and swaps to it without dropping in-flight queries.

Every BigQuery job carries `maximumBytesBilled` (`BIGQUERY_MAX_BYTES_BILLED`,
default 200 GiB), and the client refuses a service account from any project
other than `GCP_PROJECT_ID`.

## Programmatic pages

`/companies-using/` (a searchable hub), `/companies-using/<slug>/` for every technology with at least
100 sites, plus `/categories/` and `/categories/<slug>/`. Each page leads with its list (top sites, or
technologies ranked) and keeps the explanation and FAQ below it. The plan (templates, quality bar, rollout) is the Notion page "WhichSitesUse
programmatic SEO plan"; the thresholds live only in `src/seo/config.ts`.

- `src/seo/dataset.ts` turns a snapshot into one JSON file per month: counts by popularity bucket, the
  best-ranked sites, co-usage from a hash sample, CWV pass rates, versions, TLDs and categories, plus each
  technology's logo and description from HTTP Archive's Tech Report catalog (`src/seo/catalog.ts`).
  The pipeline writes it to R2 as `seo/<month>/dataset.json` with its own pointer, `seo/current.json`.
- `src/seo/pages.ts` renders the pages from that file with the site's shared partials
  (`scripts/site-partials`) and `site/seo.css`. A section only shows when its data clears the bar in `SEO_RULES`.
  Keyword headings and detection notes for a few technologies (Shopify, HubSpot, Salesforce, Stripe) live in
  `src/seo/overrides.ts`; numbers never go there.
- Every page has its own title, description, canonical, Open Graph and Twitter tags, and one JSON-LD graph built
  with `src/seo/schema.ts`. Its OG image is drawn on request at `https://api.whichsitesuse.com/og/<path>.png`
  (`src/og/routes.ts`, using the shared card in `src/og/card.ts`).
- The API serves them (`src/seo/routes.ts`) and whichsitesuse.com reaches them through Render rewrites on the
  static site: `/companies-using/*`, `/categories/*` and `/sitemaps/*` to the same path on `https://api.whichsitesuse.com`.
  Render serves a real file before a rewrite, so keep `site/companies-using/` and `site/categories/` empty.
  The API host's own robots.txt disallows these paths, so only the whichsitesuse.com copies get indexed.
- `npm run seo:export -- <dataset.json> <outDir>` writes the site plus every page as static files, for previews.

## Deploying on Render

- Web service: build `npm ci && npm run build`, start `npm run start:web` (applies migrations, then serves).
- Cron job: build `npm ci && npm run build`, command `npm run pipeline`.
- Secrets go straight into Render's environment, never into the repo. See `.env.example` for names.

## Data attribution

Technology detections come from HTTP Archive, using its open-source Wappalyzer
fork; Core Web Vitals come from the Chrome UX Report. Every response credits
them.
