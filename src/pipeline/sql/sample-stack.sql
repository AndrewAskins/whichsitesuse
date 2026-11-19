-- One domain's detections in the crawl (homepage examples). Mobile homepage only.
SELECT rank, t.technology, ARRAY_TO_STRING(t.categories, ', ') AS categories, ARRAY_TO_STRING(t.info, ', ') AS version
FROM `httparchive.crawl.pages`, UNNEST(technologies) AS t
WHERE date = @crawl_date AND client = 'mobile' AND is_root_page AND root_page = @root_page
ORDER BY t.technology
