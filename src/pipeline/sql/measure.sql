-- Sizes the extract without writing it anywhere: rows, sites, detections per
-- site, and raw bytes of the columns we keep (Parquet will be far smaller).
-- Scans the same source bytes as the extract itself. The placeholder below is replaced
-- with extract.sql.
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT domain) AS sites,
  COUNTIF(technology IS NOT NULL) AS detections,
  SAFE_DIVIDE(COUNTIF(technology IS NOT NULL), COUNT(DISTINCT domain)) AS avg_detections_per_site,
  COUNT(DISTINCT technology) AS technologies,
  COUNT(DISTINCT IF(lcp_p75_mobile IS NOT NULL OR lcp_p75_desktop IS NOT NULL, domain, NULL)) AS sites_with_cwv,
  COUNT(DISTINCT IF(on_mobile, domain, NULL)) AS sites_mobile,
  COUNT(DISTINCT IF(on_desktop, domain, NULL)) AS sites_desktop,
  SUM(
    LENGTH(domain) + IFNULL(LENGTH(technology), 0) + IFNULL(LENGTH(version), 0)
    + IFNULL((SELECT SUM(LENGTH(c)) FROM UNNEST(categories) AS c), 0)
  ) AS raw_string_bytes
FROM ({{EXTRACT}})
