-- Copyright The OpenTelemetry Authors
-- SPDX-License-Identifier: Apache-2.0
--
-- Transactions written by the opt-in `payment-charge` Supabase Edge Function
-- (supabase/functions/payment-charge/index.ts). The edge function connects with
-- the service role, which bypasses RLS; RLS is enabled with no public policy so
-- anon/authenticated clients get no access.
--
-- Apply with the Supabase CLI or MCP:
--   supabase db push        (from a linked project), or
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/migrations/0003_transactions.sql

CREATE TABLE IF NOT EXISTS public.transactions (
    transaction_id UUID PRIMARY KEY,
    card_type TEXT NOT NULL,
    last_four TEXT NOT NULL,
    amount_units BIGINT NOT NULL,
    amount_nanos INT NOT NULL,
    currency_code TEXT NOT NULL,
    loyalty_level TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
