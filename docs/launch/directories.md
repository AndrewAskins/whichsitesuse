# Directory and registry submissions

Prepared, not submitted. Each listing goes out only on Andrew's yes. The spec
(Notion) is the source of truth for which channels matter; this file only holds
what each one needs and the exact steps.

## Before any listing

These block every submission below:

1. **api.whichsitesuse.com points at the API.** Done Nov 19: the custom domain
   is live with its certificate and `PUBLIC_BASE_URL` is set to it.
2. **A first snapshot is published.** Reviewers call the tools; until the
   snapshot loads, data tools answer `snapshot_unavailable`.
3. **Privacy policy and terms pages** on whichsitesuse.com. Claude and ChatGPT
   both ask for a privacy policy URL. Draft text needs Andrew's review.
4. **A docs page** with the tool list, credit costs and how to get an API key
   (the README's tables are the starting point).

## Official MCP registry (self-serve)

File: `server.json` at the repo root. Name `com.whichsitesuse/whichsitesuse`,
which the registry verifies through DNS on whichsitesuse.com. Version must
match `VERSION` in `src/app.ts` (a test checks this).

Steps for Andrew, once the blockers above are done:

1. Make a key pair locally (the private key never goes in the repo or chat):
   ```
   openssl genpkey -algorithm Ed25519 -out wsu-registry.pem
   openssl pkey -in wsu-registry.pem -pubout -outform DER | tail -c 32 | base64
   ```
2. Add a TXT record on whichsitesuse.com in Cloudflare:
   `v=MCPv1; k=ed25519; p=<the base64 from step 1>`
3. Install the publisher and log in with the private key:
   ```
   brew install mcp-publisher
   PRIV=$(openssl pkey -in wsu-registry.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')
   mcp-publisher login dns --domain whichsitesuse.com --private-key "$PRIV"
   ```
4. From the repo root: `mcp-publisher publish`

PulseMCP and several other directories ingest the official registry, so this
one listing feeds them.

## Claude connector directory (review, not self-serve)

Needs, beyond the blockers:

- **OAuth.** Built (PR #16): OAuth 2.1 with PKCE and dynamic client
  registration, or an API key as a Bearer token. Scope `mcp`. The issuer and
  resource come from `PUBLIC_BASE_URL`, so it must be
  `https://api.whichsitesuse.com` on the API service before submitting.
- **Tool annotations.** Done: every tool sets `readOnlyHint`,
  `destructiveHint: false`, `idempotentHint` and `openWorldHint` (tested in
  `tests/http.test.ts`).
- **A test account** with credits for the reviewers, and the steps to use it.
- Listing copy: name, one-line description, longer description, logo
  (`brand/final` in the project folder), support contact, privacy policy URL.

Listing copy draft:

- **Name:** WhichSitesUse
- **One line:** Find which websites use a technology, and what any domain runs.
- **Description:** WhichSitesUse answers "which sites use Shopify in the top
  100k" and "what is this site built with" from HTTP Archive's monthly crawl of
  about 15 million websites, with Core Web Vitals from the Chrome UX Report.
  Counts and technology search are free. Lists cost 1 credit per site and a
  domain lookup costs 2, and every call shows what it spent.

## ChatGPT app (v1.1)

Needs OAuth (built, PR #16), a verified OpenAI Platform organization, the privacy policy, and a
demo login with sample data that works without sign-up or 2FA. Credits can't be
sold or promoted inside ChatGPT, so `buy_credits` must be left out of the
ChatGPT build of the server. Reuses Chartjuice's MCP Apps setup.

## Other directories

| Directory | How it lists | What we do |
| --- | --- | --- |
| Smithery | Add a remote server by URL in their dashboard | Paste `https://api.whichsitesuse.com/mcp`, mark the Authorization header as the config |
| Glama | Indexes public GitHub repos and remote servers | Claim the listing once the repo is public, or submit the URL |
| mcp.so | Submission form | Name, URL, description from above |
| PulseMCP | Reads the official registry | Nothing extra after the registry listing |
| Cursor | One-click install link on our docs page | Add a `cursor://anysphere.cursor-deeplink/mcp/install` button to the docs page |

## Firecrawl Alexandria

Provider waitlist at alexandria.firecrawl.dev, then a pitch with live usage.
Pricing rule from the spec: WhichSitesUse credits times 2 Firecrawl credits.
