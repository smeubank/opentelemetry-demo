-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Supabase Queues (pgmq) backend for the order post-processing flow. This is the
-- opt-in alternative to Kafka: checkout produces each OrderResult onto two queues
-- and the accounting + fraud-detection services poll one each. See supa-pgmq-kafka.md.
--
-- Two queues reproduce Kafka's fan-out (independent consumer groups): a single
-- shared queue is competing-consumers, so each order would reach only one consumer.
-- Services connect with the DB role over the session pooler, which bypasses RLS, so
-- no pgmq_public / RLS / Data-API grants are needed.
--
-- Apply with the Supabase CLI or MCP:
--   supabase db push        (from a linked project), or
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/migrations/0004_pgmq_queues.sql

CREATE EXTENSION IF NOT EXISTS pgmq;

-- pgmq.create errors if the queue already exists, so guard on pgmq.list_queues
-- to keep this migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'orders_accounting') THEN
    PERFORM pgmq.create('orders_accounting');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'orders_fraud') THEN
    PERFORM pgmq.create('orders_fraud');
  END IF;
END $$;
