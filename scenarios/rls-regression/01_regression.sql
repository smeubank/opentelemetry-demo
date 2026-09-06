-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Scenario: rls-regression — THE CHANGE ("after").
-- This is the boundary the investigating agent must find. It adds a 4th permissive
-- SELECT policy whose USING clause calls auth.uid() BARE inside a correlated EXISTS
-- subquery. Because the call is not wrapped in (SELECT ...), Postgres cannot hoist it
-- into an initplan and re-evaluates it for every candidate row. Read latency on the
-- feed steps up sharply. Nothing on the client changed — the query text is identical.
--
-- Effect on Supabase advisors:
--   * auth_rls_initplan          -> fires (bare auth.uid() re-evaluated per row)
--   * multiple_permissive_policies -> fires (4 permissive SELECT policies for the
--                                      authenticated role on one table)

DROP POLICY IF EXISTS "reviews shared are readable" ON shop.product_reviews;
CREATE POLICY "reviews shared are readable"
    ON shop.product_reviews FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM shop.review_shares s
            WHERE s.review_id = shop.product_reviews.id
              AND s.shared_with = auth.uid()   -- BARE auth.uid(): re-evaluated per row
        )
    );

-- Record the change the way production does: a timestamped migration row. This is the
-- ONLY timestamped evidence of when the policy appeared (pg_policies carries none).
-- The version string is the migration timestamp; set it to the scenario's change point.
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY,
    name text
);
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES (to_char(now(), 'YYYYMMDDHH24MISS'), 'add_review_shares_policy')
ON CONFLICT (version) DO NOTHING;
