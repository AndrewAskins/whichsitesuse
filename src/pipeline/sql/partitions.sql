-- Newest partitions of a table, for the dry-run report. Metadata only.
SELECT
  partition_id,
  total_rows,
  total_logical_bytes,
  last_modified_time
FROM `{{DATASET}}.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = @table_name
  AND REGEXP_CONTAINS(partition_id, r'^\d{6,8}$')
ORDER BY partition_id DESC
LIMIT 4
