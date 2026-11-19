-- Newest complete HTTP Archive month: partitions are YYYYMMDD; skip a month
-- that is still loading (small, or written to in the last three days).
SELECT PARSE_DATE('%Y%m%d', partition_id) AS crawl_date, total_rows
FROM `httparchive.crawl.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = 'pages'
  AND REGEXP_CONTAINS(partition_id, r'^\d{8}$')
  AND total_rows > 20000000
  AND last_modified_time < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
ORDER BY crawl_date DESC
LIMIT 1
