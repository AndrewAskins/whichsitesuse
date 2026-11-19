-- Accounts, billing and admin, on top of 0001 and 0002.

ALTER TABLE accounts
  ADD COLUMN stripe_subscription_id  text UNIQUE,
  -- Stripe's subscription status (active, past_due, canceled...), null without one.
  ADD COLUMN plan_status             text,
  -- Set on the first successful payment. Until then the account is on the trial caps.
  ADD COLUMN first_paid_at           timestamptz,
  ADD COLUMN signup_ip               inet,
  ADD COLUMN signup_fingerprint_hash text,
  ADD COLUMN suspended_reason        text;

-- Signed-in browser sessions for the account and admin pages. Only the hash is stored.
CREATE TABLE web_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_sessions_account_idx ON web_sessions (account_id);

-- Stripe webhook events already processed, so a retried delivery is a no-op.
CREATE TABLE stripe_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- A Stripe invoice, checkout session or grant adds credits once, however often it is replayed.
CREATE UNIQUE INDEX credit_ledger_ref_once
  ON credit_ledger (kind, ref)
  WHERE ref IS NOT NULL AND kind IN ('grant', 'plan', 'topup', 'refund');

-- One open free-credit request per account.
CREATE UNIQUE INDEX free_credit_requests_one_pending
  ON free_credit_requests (account_id)
  WHERE status = 'pending';

-- Alerts sent to the admin, deduplicated per key (e.g. one "grants per day" alert per day).
CREATE TABLE admin_alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_account_month_idx ON usage_events (account_id, created_at) WHERE credits > 0;
CREATE INDEX free_grants_created_idx ON free_grants (created_at);
