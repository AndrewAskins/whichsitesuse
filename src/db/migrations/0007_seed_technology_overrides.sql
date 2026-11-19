-- First technology cleanup: the shorthand people search for, vendor domains and
-- one disambiguation note. Keys are HTTP Archive's technology names exactly; a
-- name the crawl doesn't use simply matches nothing. Only aliases, vendors and
-- notes here: nothing is merged or hidden, so counts stay as the crawl reports.
-- Rows already in the table are left as they are.
INSERT INTO technology_overrides (source_name, vendor_domain, aliases, note, updated_by) VALUES
  ('Google Tag Manager',        'google.com',        ARRAY['GTM'], NULL, 'seed'),
  ('Google Analytics',          'google.com',        ARRAY['GA', 'GA4', 'Universal Analytics'], NULL, 'seed'),
  ('Google Ads',                'google.com',        ARRAY['AdWords'], NULL, 'seed'),
  ('Google Font API',           'google.com',        ARRAY['Google Fonts'], NULL, 'seed'),
  ('Microsoft Advertising',     'microsoft.com',     ARRAY['Bing Ads'], NULL, 'seed'),
  ('Facebook Pixel',            'facebook.com',      ARRAY['Meta Pixel'], NULL, 'seed'),
  ('Meta Pixel',                'facebook.com',      ARRAY['Facebook Pixel'], NULL, 'seed'),
  ('WordPress',                 'wordpress.org',     ARRAY['WP'], NULL, 'seed'),
  ('WooCommerce',               'woocommerce.com',   ARRAY['Woo'], NULL, 'seed'),
  ('Yoast SEO',                 'yoast.com',         ARRAY['Yoast'], NULL, 'seed'),
  ('Shopify',                   'shopify.com',       ARRAY[]::text[], NULL, 'seed'),
  ('Magento',                   'adobe.com',         ARRAY['Adobe Commerce'], NULL, 'seed'),
  ('Adobe Experience Manager',  'adobe.com',         ARRAY['AEM'], NULL, 'seed'),
  ('Salesforce Commerce Cloud', 'salesforce.com',    ARRAY['SFCC', 'Demandware'], NULL, 'seed'),
  ('Pardot',                    'salesforce.com',    ARRAY['Account Engagement', 'Marketing Cloud Account Engagement'], NULL, 'seed'),
  ('Amazon Web Services',       'aws.amazon.com',    ARRAY['AWS'], NULL, 'seed'),
  ('Google Cloud',              'cloud.google.com',  ARRAY['GCP'], NULL, 'seed'),
  ('React',                     'react.dev',         ARRAY['ReactJS'], NULL, 'seed'),
  ('Vue.js',                    'vuejs.org',         ARRAY['Vue'], NULL, 'seed'),
  ('Nuxt.js',                   'nuxt.com',          ARRAY['Nuxt'], NULL, 'seed'),
  ('Node.js',                   'nodejs.org',        ARRAY['Node'], NULL, 'seed'),
  ('HubSpot',                   'hubspot.com',       ARRAY[]::text[], NULL, 'seed'),
  ('Klaviyo',                   'klaviyo.com',       ARRAY[]::text[], NULL, 'seed'),
  ('Stripe',                    'stripe.com',        ARRAY[]::text[], NULL, 'seed'),
  ('Doppler',                   'fromdoppler.com',   ARRAY[]::text[],
     'Doppler is fromdoppler.com email marketing, not the Doppler secrets manager.', 'seed')
ON CONFLICT (source_name) DO NOTHING;
