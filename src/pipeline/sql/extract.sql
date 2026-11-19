-- WhichSitesUse monthly extract: one row per (site, technology), plus one row
-- with a NULL technology for each crawled site with no detections.
-- Params: @crawl_date (HTTP Archive month), @crux_date (CrUX month, may be NULL).
-- Reads only the columns it needs: the Lighthouse, payload and custom metric
-- columns are never touched, which is what keeps this inside the free tier.
WITH pages AS (
  SELECT
    client,
    LOWER(REGEXP_REPLACE(NET.HOST(root_page), r'^www\.', '')) AS domain,
    root_page,
    rank,
    technologies
  FROM `httparchive.crawl.pages`
  WHERE date = @crawl_date
),
sites AS (
  SELECT
    domain,
    -- Prefer the https origin when a site was crawled under more than one.
    ARRAY_AGG(root_page ORDER BY STARTS_WITH(root_page, 'https://') DESC, root_page LIMIT 1)[OFFSET(0)] AS root_url,
    MIN(rank) AS rank_bucket,
    LOGICAL_OR(client = 'mobile') AS on_mobile,
    LOGICAL_OR(client = 'desktop') AS on_desktop
  FROM pages
  WHERE domain IS NOT NULL AND domain != ''
  GROUP BY domain
),
tech AS (
  SELECT
    domain,
    t.technology,
    ANY_VALUE(t.categories) AS categories,
    -- Wappalyzer puts the detected version, when it has one, in info.
    MAX(NULLIF(t.info[SAFE_OFFSET(0)], '')) AS version,
    LOGICAL_OR(client = 'mobile') AS tech_on_mobile,
    LOGICAL_OR(client = 'desktop') AS tech_on_desktop
  FROM pages, UNNEST(technologies) AS t
  WHERE t.technology IS NOT NULL AND t.technology != ''
  GROUP BY domain, technology
),
crux AS (
  -- Origin-level field data. Several origins (http/https, www) can map to one
  -- domain; MAX keeps the worst p75, so a "passing" label is never optimistic.
  SELECT
    LOWER(REGEXP_REPLACE(NET.HOST(origin), r'^www\.', '')) AS domain,
    MAX(IF(device = 'phone', p75_lcp, NULL)) AS lcp_p75_mobile,
    MAX(IF(device = 'phone', p75_inp, NULL)) AS inp_p75_mobile,
    MAX(IF(device = 'phone', p75_cls, NULL)) AS cls_p75_mobile,
    MAX(IF(device = 'desktop', p75_lcp, NULL)) AS lcp_p75_desktop,
    MAX(IF(device = 'desktop', p75_inp, NULL)) AS inp_p75_desktop,
    MAX(IF(device = 'desktop', p75_cls, NULL)) AS cls_p75_desktop
  FROM `chrome-ux-report.materialized.device_summary`
  WHERE date = @crux_date
  GROUP BY domain
)
SELECT
  s.domain,
  s.root_url,
  s.rank_bucket,
  s.on_mobile,
  s.on_desktop,
  c.lcp_p75_mobile,
  c.inp_p75_mobile,
  c.cls_p75_mobile,
  c.lcp_p75_desktop,
  c.inp_p75_desktop,
  c.cls_p75_desktop,
  t.technology,
  t.categories,
  t.version,
  t.tech_on_mobile,
  t.tech_on_desktop
FROM sites AS s
LEFT JOIN tech AS t USING (domain)
LEFT JOIN crux AS c USING (domain)
