-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Supabase schema for the OpenTelemetry Astronomy Shop.
-- Adapted from src/postgresql/init.sql for a hosted Supabase Postgres project:
--   * No role/database/user creation (Supabase manages roles; app services connect
--     via the pooler as the built-in postgres role, which owns these objects and
--     bypasses RLS).
--   * RLS is enabled on every table. The service/postgres roles used by the backend
--     services bypass RLS, so reads/writes are unaffected; anon/authenticated get no
--     access unless a policy grants it (catalog.products is world-readable).
--
-- Apply with the Supabase CLI or MCP (uses the direct connection):
--   supabase db push        (from a linked project), or
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/migrations/0001_init_catalog_accounting.sql

-- ---------------------------------------------------------------------------
-- Accounting Service schema
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS accounting;

CREATE TABLE IF NOT EXISTS accounting."order" (
    order_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS accounting.shipping (
    shipping_tracking_id TEXT PRIMARY KEY,
    shipping_cost_currency_code TEXT NOT NULL,
    shipping_cost_units BIGINT NOT NULL,
    shipping_cost_nanos INT NOT NULL,
    street_address TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    zip_code TEXT,
    order_id TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES accounting."order"(order_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS accounting.orderitem (
    item_cost_currency_code TEXT NOT NULL,
    item_cost_units BIGINT NOT NULL,
    item_cost_nanos INT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INT NOT NULL,
    order_id TEXT NOT NULL,
    PRIMARY KEY (order_id, product_id),
    FOREIGN KEY (order_id) REFERENCES accounting."order"(order_id) ON DELETE CASCADE
);

-- Accounting data is service-role-only: enable RLS with no anon/authenticated policies.
ALTER TABLE accounting."order"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.shipping   ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.orderitem  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Product Catalog Service schema
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE IF NOT EXISTS catalog.products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    picture TEXT,
    price_currency_code TEXT NOT NULL,
    price_units BIGINT NOT NULL,
    price_nanos INT NOT NULL,
    categories TEXT
);

ALTER TABLE catalog.products ENABLE ROW LEVEL SECURITY;

-- Products are public catalog data: allow read access to anon + authenticated clients
-- (in case the frontend later reads them directly via supabase-js). The Go backend
-- connects as postgres and bypasses RLS regardless.
DROP POLICY IF EXISTS "products are readable by everyone" ON catalog.products;
CREATE POLICY "products are readable by everyone"
    ON catalog.products FOR SELECT
    TO anon, authenticated
    USING (true);

-- Product Catalog Service: seed product data
INSERT INTO catalog.products (id, name, description, picture, price_currency_code, price_units, price_nanos, categories)
VALUES
    ('OLJCESPC7Z', 'National Park Foundation Explorascope', 'The National Park Foundation''s (NPF) Explorascope 60AZ is a manual alt-azimuth, refractor telescope perfect for celestial viewing on the go. The NPF Explorascope 60 can view the planets, moon, star clusters and brighter deep sky objects like the Orion Nebula and Andromeda Galaxy.', 'NationalParkFoundationExplorascope.jpg', 'USD', 101, 960000000, 'telescopes'),
    ('66VCHSJNUP', 'Starsense Explorer Refractor Telescope', 'The first telescope that uses your smartphone to analyze the night sky and calculate its position in real time. StarSense Explorer is ideal for beginners thanks to the app''s user-friendly interface and detailed tutorials. It''s like having your own personal tour guide of the night sky', 'StarsenseExplorer.jpg', 'USD', 349, 950000000, 'telescopes'),
    ('1YMWWN1N4O', 'Eclipsmart Travel Refractor Telescope', 'Dedicated white-light solar scope for the observer on the go. The 50mm refracting solar scope uses Solar Safe, ISO compliant, full-aperture glass filter material to ensure the safest view of solar events.  The kit comes complete with everything you need, including the dedicated travel solar scope, a Solar Safe finderscope, tripod, a high quality 20mm (18x) Kellner eyepiece and a nylon backpack to carry everything in.  This Travel Solar Scope makes it easy to share the Sun as well as partial and total solar eclipses with the whole family and offers much higher magnifications than you would otherwise get using handheld solar viewers or binoculars.', 'EclipsmartTravelRefractorTelescope.jpg', 'USD', 129, 950000000, 'telescopes,travel'),
    ('L9ECAV7KIM', 'Lens Cleaning Kit', 'Wipe away dust, dirt, fingerprints and other particles on your lenses to see clearly with the Lens Cleaning Kit. This cleaning kit works on all glass and optical surfaces, including telescopes, binoculars, spotting scopes, monoculars, microscopes, and even your camera lenses, computer screens, and mobile devices.  The kit comes complete with a retractable lens brush to remove dust particles and dirt and two options to clean smudges and fingerprints off of your optics, pre-moistened lens wipes and a bottled lens cleaning fluid with soft cloth.', 'LensCleaningKit.jpg', 'USD', 21, 950000000, 'accessories'),
    ('2ZYFJ3GM2N', 'Roof Binoculars', 'This versatile, all-around binocular is a great choice for the trail, the stadium, the arena, or just about anywhere you want a close-up view of the action without sacrificing brightness or detail. It''s an especially great companion for nature observation and bird watching, with ED glass that helps you spot the subtlest field markings and a close focus of just 6.5 feet.', 'RoofBinoculars.jpg', 'USD', 209, 950000000, 'binoculars'),
    ('0PUK6V6EV0', 'Solar System Color Imager', 'You have your new telescope and have observed Saturn and Jupiter. Now you''re ready to take the next step and start imaging them. But where do you begin? The NexImage 10 Solar System Imager is the perfect solution.', 'SolarSystemColorImager.jpg', 'USD', 175, 0, 'accessories,telescopes'),
    ('LS4PSXUNUM', 'Red Flashlight', 'This 3-in-1 device features a 3-mode red flashlight, a hand warmer, and a portable power bank for recharging your personal electronics on the go. Whether you use it to light the way at an astronomy star party, a night walk, or wildlife research, ThermoTorch 3 Astro Red''s rugged, IPX4-rated design will withstand your everyday activities.', 'RedFlashlight.jpg', 'USD', 57, 80000000, 'accessories,flashlights'),
    ('9SIQT8TOJO', 'Optical Tube Assembly', 'Capturing impressive deep-sky astroimages is easier than ever with Rowe-Ackermann Schmidt Astrograph (RASA) V2, the perfect companion to today''s top DSLR or astronomical CCD cameras. This fast, wide-field f/2.2 system allows for shorter exposure times compared to traditional f/10 astroimaging, without sacrificing resolution. Because shorter sub-exposure times are possible, your equatorial mount won''t need to accurately track over extended periods. The short focal length also lessens equatorial tracking demands. In many cases, autoguiding will not be required.', 'OpticalTubeAssembly.jpg', 'USD', 3599, 0, 'accessories,telescopes,assembly'),
    ('6E92ZMYYFZ', 'Solar Filter', 'Enhance your viewing experience with EclipSmart Solar Filter for 8" telescopes. With two Velcro straps and four self-adhesive Velcro pads for added safety, you can be assured that the solar filter cannot be accidentally knocked off and will provide Solar Safe, ISO compliant viewing.', 'SolarFilter.jpg', 'USD', 69, 950000000, 'accessories,telescopes'),
    ('HQTGWGPNH4', 'The Comet Book', 'A 16th-century treatise on comets, created anonymously in Flanders (now northern France) and now held at the Universitätsbibliothek Kassel. Commonly known as The Comet Book (or Kometenbuch in German), its full title translates as "Comets and their General and Particular Meanings, According to Ptolomeé, Albumasar, Haly, Aliquind and other Astrologers". The image is from https://publicdomainreview.org/collection/the-comet-book, made available by the Universitätsbibliothek Kassel under a CC-BY SA 4.0 license (https://creativecommons.org/licenses/by-sa/4.0/)', 'TheCometBook.jpg', 'USD', 0, 990000000, 'books')
ON CONFLICT (id) DO NOTHING;
