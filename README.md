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

`count_sites` and `search_sites` share one filter (`src/operations/siteFilters.ts`).
REST takes lists as `technologies=shopify,klaviyo` or repeated params, and CWV as `cwv=lcp:pass,cls:fail`.

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
- `monthly` writes the snapshot (next build step).

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
