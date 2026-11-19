-- One origin's p75 Core Web Vitals on phones for the CrUX month.
SELECT date, p75_lcp, p75_inp, p75_cls
FROM `chrome-ux-report.materialized.device_summary`
WHERE date = @crux_date AND origin = @origin AND device = 'phone'
