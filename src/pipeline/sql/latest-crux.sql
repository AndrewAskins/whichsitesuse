-- Newest CrUX month at or before the crawl month.
SELECT MAX(date) AS crux_date
FROM `chrome-ux-report.materialized.device_summary`
WHERE date <= @crawl_date
  AND date >= DATE_SUB(@crawl_date, INTERVAL 4 MONTH)
