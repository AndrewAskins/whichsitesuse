-- Accounts, API keys, credits and usage. Snapshot data lives in Parquet, not here.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  -- Lowercased, dots and +tags stripped where the provider ignores them; one inbox is one person.
  email_normalized    text NOT NULL UNIQUE,
  email_domain        text NOT NULL,
  email_verified_at   timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan                text NOT NULL DEFAULT 'none' CHECK (plan IN ('none', 'starter', 'growth', 'pro')),
  plan_renews_at      timestamptz,
  stripe_customer_id  text UNIQUE,
  is_admin            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_email_domain_idx ON accounts (email_domain);

-- Magic links for verification and sign-in. Only the hash is stored.
CREATE TABLE login_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'login')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- First characters shown in the dashboard, e.g. "wsu_live_ab12".
  prefix              text NOT NULL,
  key_hash            text NOT NULL UNIQUE,
  -- Monthly credit cap set by the account owner; null means no cap.
  monthly_credit_cap  integer CHECK (monthly_credit_cap IS NULL OR monthly_credit_cap >= 0),
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id);

-- Credits are held in lots so each bucket keeps its own expiry:
-- plan credits reset monthly, top-ups last 12 months, the trial grant has trial caps.
CREATE TABLE credit_lots (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  bucket      text NOT NULL CHECK (bucket IN ('trial', 'plan', 'topup')),
  original    integer NOT NULL CHECK (original > 0),
  remaining   integer NOT NULL CHECK (remaining >= 0 AND remaining <= original),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_lots_spendable_idx ON credit_lots (account_id, bucket, expires_at) WHERE remaining > 0;

-- Every grant, purchase, spend, refund, expiry and revoke, as an append-only audit trail.
CREATE TABLE credit_ledger (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  lot_id      bigint REFERENCES credit_lots (id),
  kind        text NOT NULL CHECK (kind IN ('grant', 'plan', 'topup', 'spend', 'refund', 'expire', 'revoke', 'adjust')),
  -- Positive adds credits, negative removes them.
  amount      integer NOT NULL,
  -- Stripe object id, usage event id, or admin note reference.
  ref         text,
  note        text,
  created_by  text NOT NULL DEFAULT 'system',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_account_idx ON credit_ledger (account_id, created_at DESC);

CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  account_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
  api_key_id    uuid REFERENCES api_keys (id) ON DELETE SET NULL,
  operation     text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('mcp', 'rest', 'web', 'alexandria')),
  credits       integer NOT NULL DEFAULT 0,
  result_count  integer,
  status        text NOT NULL CHECK (status IN ('ok', 'error')),
  error_code    text,
  params        jsonb,
  crawl_date    date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_account_idx ON usage_events (account_id, created_at DESC);
CREATE INDEX usage_events_key_month_idx ON usage_events (api_key_id, created_at);
