-- Our cleanup of HTTP Archive's technology names, applied by the monthly pipeline.
CREATE TABLE technology_overrides (
  -- The technology name exactly as HTTP Archive reports it.
  source_name    text PRIMARY KEY,
  display_name   text,
  vendor_domain  text,
  categories     text[],
  aliases        text[] NOT NULL DEFAULT '{}',
  -- Disambiguation, e.g. "Doppler is fromdoppler.com email marketing, not the secrets manager."
  note           text,
  -- Fold this technology into another canonical name.
  merge_into     text,
  hidden         boolean NOT NULL DEFAULT false,
  updated_by     text NOT NULL DEFAULT 'system',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
