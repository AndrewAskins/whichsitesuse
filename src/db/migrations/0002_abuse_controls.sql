-- Free-grant abuse controls (spec: one grant per person, work email, device and network signals).

-- One row per granted (or withheld) free grant. The unique email keeps it to one per person.
CREATE TABLE free_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  email_normalized  text NOT NULL UNIQUE,
  status            text NOT NULL CHECK (status IN ('granted', 'withheld', 'manual', 'revoked')),
  reason            text,
  credits           integer NOT NULL DEFAULT 0,
  ip                inet,
  ip_prefix         cidr,
  fingerprint_hash  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX free_grants_ip_prefix_idx ON free_grants (ip_prefix, created_at);
CREATE INDEX free_grants_fingerprint_idx ON free_grants (fingerprint_hash);

CREATE TABLE abuse_signals (
  id                bigserial PRIMARY KEY,
  account_id        uuid REFERENCES accounts (id) ON DELETE CASCADE,
  kind              text NOT NULL,
  ip                inet,
  ip_prefix         cidr,
  fingerprint_hash  text,
  email_domain      text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX abuse_signals_kind_idx ON abuse_signals (kind, created_at DESC);

-- Disposable and free-mail domains, refreshed weekly from maintained lists.
CREATE TABLE blocked_email_domains (
  domain      text PRIMARY KEY,
  list        text NOT NULL CHECK (list IN ('disposable', 'freemail')),
  source      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Domains approved by hand after a false positive; they pass the work-email check from then on.
CREATE TABLE allowed_email_domains (
  domain       text PRIMARY KEY,
  approved_by  text NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- "Request free credits" form for people the work-email check turned away.
CREATE TABLE free_credit_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  message      text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by  text,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX free_credit_requests_pending_idx ON free_credit_requests (created_at) WHERE status = 'pending';
