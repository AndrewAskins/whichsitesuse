-- Writes the extract to GCS as Parquet. The URI placeholder becomes
-- gs://<bucket>/extract/<crawl_date>/*.parquet and the extract placeholder
-- becomes extract.sql. Billed like the extract itself (bytes scanned).
EXPORT DATA OPTIONS (
  uri = '{{URI}}',
  format = 'PARQUET',
  compression = 'ZSTD',
  overwrite = true
) AS
{{EXTRACT}}
