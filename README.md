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
- **Pages**: `/signup`, `/login`, `/account` (balance, API keys and caps, buy), `/request-credits`, `/admin`
  (abuse dashboard, request review, revoke and suspend). Accounts in `ADMIN_EMAILS` become admins when they verify.
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
- `monthly` runs `EXPORT DATA` to `gs://$GCS_BUCKET/extract/<month>/`, downloads the files, builds the snapshot with DuckDB (`src/pipeline/transform.ts`: technology overrides from Postgres applied, `first_seen` carried from last month), uploads it to R2 under `snapshots/<month>/`, then rewrites `snapshots/current.json`. It skips a month that is already current unless `CRAWL_DATE` pins one.

The query service (`src/data/sync.ts`) downloads the month `current.json` points at into its own directory and swaps to it without dropping in-flight queries.

Every BigQuery job carries `maximumBytesBilled` (`BIGQUERY_MAX_BYTES_BILLED`,
default 200 GiB), and the client refuses a service account from any project
other than `GCP_PROJECT_ID`.

## Deploying on Render

- Web service: build `npm ci && npm run build`, start `npm run start:web` (applies migrations, then serves).
- Cron job: build `npm ci && npm run build`, command `npm run pipeline`.
- Secrets go straight into Render's environment, never into the repo. See `.env.example` for names.

## Data attribution

Technology detections come from HTTP Archive, using its open-source Wappalyzer
fork; Core Web Vitals come from the Chrome UX Report. Every response credits
them.
