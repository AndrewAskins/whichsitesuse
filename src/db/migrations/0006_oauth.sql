-- OAuth 2.1 for MCP clients (Claude, ChatGPT and other directories).
-- An approved connection is an api_keys row (with oauth_client_id set), so caps,
-- usage, revocation and the dashboard work the same as for API keys.

CREATE TABLE oauth_clients (
  client_id                   text PRIMARY KEY,
  -- Null for public clients (token_endpoint_auth_method "none").
  client_secret_hash          text,
  client_name                 text NOT NULL,
  redirect_uris               text[] NOT NULL,
  token_endpoint_auth_method  text NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  created_ip                  inet,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE api_keys ADD COLUMN oauth_client_id text REFERENCES oauth_clients (client_id) ON DELETE SET NULL;

-- Authorization codes: single use, short-lived, PKCE-bound. Only the hash is stored.
CREATE TABLE oauth_codes (
  code_hash           text PRIMARY KEY,
  client_id           text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  redirect_uri        text NOT NULL,
  code_challenge      text NOT NULL,
  scope               text NOT NULL,
  monthly_credit_cap  integer CHECK (monthly_credit_cap IS NULL OR monthly_credit_cap >= 0),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  -- The connection the code was exchanged for, so a replayed code can revoke it.
  api_key_id          uuid REFERENCES api_keys (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Access and refresh tokens for a connection. Refresh tokens rotate: each use revokes its row.
CREATE TABLE oauth_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id          uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  access_hash         text NOT NULL UNIQUE,
  access_expires_at   timestamptz NOT NULL,
  refresh_hash        text NOT NULL UNIQUE,
  refresh_expires_at  timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_key_idx ON oauth_tokens (api_key_id);
