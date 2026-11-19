-- Mobile homepages using each technology in the crawl month.
SELECT t.technology, COUNT(DISTINCT root_page) AS site_count
FROM `httparchive.crawl.pages`, UNNEST(technologies) AS t
WHERE date = @crawl_date AND client = 'mobile' AND is_root_page
  AND t.technology IN UNNEST(@technologies)
GROUP BY t.technology
ORDER BY site_count DESC
