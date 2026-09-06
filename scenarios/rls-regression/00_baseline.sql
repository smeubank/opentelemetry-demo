-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Scenario: rls-regression — BASELINE ("before").
-- A product-reviews feed read by authenticated users. RLS is intentionally cheap
-- here: three permissive SELECT policies, each wrapping auth.uid() in a scalar
-- (SELECT ...) so Postgres hoists it into an initplan and evaluates it once per
-- query, not per row. 01_regression.sql later adds the 4th policy that breaks this.

CREATE SCHEMA IF NOT EXISTS shop;
GRANT USAGE ON SCHEMA shop TO authenticated;

-- Supporting tables referenced by the policies (present from the baseline so the
-- regression migration is purely the addition of one policy).
CREATE TABLE IF NOT EXISTS shop.moderators (
    user_id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS shop.review_shares (
    review_id bigint NOT NULL,
    shared_with uuid NOT NULL,
    PRIMARY KEY (review_id, shared_with)
);

CREATE TABLE IF NOT EXISTS shop.product_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  text NOT NULL,
    author_id   uuid NOT NULL,
    rating      int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body        text NOT NULL,
    is_public   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The feed filters by product_id and orders by recency; index both so the scenario
-- isolates the RLS cost (no missing-index confounder).
CREATE INDEX IF NOT EXISTS product_reviews_product_id_created_at_idx
    ON shop.product_reviews (product_id, created_at DESC);

ALTER TABLE shop.product_reviews ENABLE ROW LEVEL SECURITY;

-- Three permissive SELECT policies. Permissive policies are OR'd; each is evaluated
-- for every candidate row, but each here hoists auth.uid() into an initplan, so the
-- per-row work is trivial.
DROP POLICY IF EXISTS "reviews public are readable" ON shop.product_reviews;
CREATE POLICY "reviews public are readable"
    ON shop.product_reviews FOR SELECT TO authenticated
    USING (is_public);

DROP POLICY IF EXISTS "reviews own are readable" ON shop.product_reviews;
CREATE POLICY "reviews own are readable"
    ON shop.product_reviews FOR SELECT TO authenticated
    USING (author_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "reviews moderators read all" ON shop.product_reviews;
CREATE POLICY "reviews moderators read all"
    ON shop.product_reviews FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) IN (SELECT user_id FROM shop.moderators));

GRANT SELECT ON shop.product_reviews TO authenticated;

-- ~5000 reviews across the demo's ten real product ids.
INSERT INTO shop.product_reviews (product_id, author_id, rating, body, is_public)
SELECT
    (ARRAY['OLJCESPC7Z','66VCHSJNUP','1YMWWN1N4O','L9ECAV7KIM','2ZYFJ3GM2N',
           '0PUK6V6EV0','LS4PSXUNUM','9SIQT8TOJO','6E92ZMYYFZ','HQTGWGPNH4'])[1 + (g % 10)],
    gen_random_uuid(),
    1 + (g % 5),
    'Review body ' || g || ' ' || repeat('lorem ipsum ', 8),
    (g % 7) <> 0            -- ~1 in 7 private
FROM generate_series(1, 5000) AS g;
