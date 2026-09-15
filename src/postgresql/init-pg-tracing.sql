-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0

-- Runs after init.sql, only when compose.pg-tracing.yaml mounts it. Creates the
-- pg_tracing views/functions; span generation and OTLP export work from
-- shared_preload_libraries alone.
CREATE EXTENSION IF NOT EXISTS pg_tracing;
\connect astronomy_db
CREATE EXTENSION IF NOT EXISTS pg_tracing;
