-- OAuth client ID metadata documents: the client_id is an https URL and the client's
-- name and redirect URIs come from the JSON document at that URL. Fetched documents
-- are kept here under their URL until metadata_expires_at, then fetched again.
ALTER TABLE oauth_clients
  ADD COLUMN metadata_document   boolean NOT NULL DEFAULT false,
  ADD COLUMN metadata_expires_at timestamptz;
