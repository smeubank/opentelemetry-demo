-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Scenario: rls-regression — teardown. Resets the scenario so it can be re-run.
-- Leaves supabase_migrations.schema_migrations intact (production never deletes
-- migration history); remove the scenario row by hand if you need a clean timeline.

DROP TABLE IF EXISTS shop.product_reviews;
DROP TABLE IF EXISTS shop.review_shares;
DROP TABLE IF EXISTS shop.moderators;
