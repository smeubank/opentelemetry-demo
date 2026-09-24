-- Data-API fault fixtures for the observability demo. Each RPC reproduces a realistic
-- production regression that surfaces as a genuine Postgres SQLSTATE through PostgREST, for
-- the scheduled observability routine to detect and correlate. SECURITY INVOKER so the error
-- is role-accurate (runs as the calling anon/authenticated role).

-- get_product_analytics(): the analytics dashboard aggregates product view stats from
-- public.product_view_stats, which a schema migration dropped/renamed. Missing relation ->
-- 42P01 -> PostgREST 404. (Demo fault-injection fixture — the relation intentionally absent.)
create or replace function public.get_product_analytics()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform * from public.product_view_stats;
end;
$$;

-- private.order_ledger holds settled order amounts; the API roles are intentionally not
-- granted access to it (a grant/RLS regression left the order-history endpoint reaching a
-- table it can no longer read). A new schema grants no USAGE to anon/authenticated by default.
create schema if not exists private;
create table if not exists private.order_ledger (
  id           bigserial primary key,
  order_id     text not null,
  amount_cents bigint not null,
  created_at   timestamptz not null default now()
);
revoke all on all tables in schema private from anon, authenticated;
revoke usage on schema private from anon, authenticated;

-- get_order_history(): customer-facing endpoint that reads the order ledger. The API role has
-- no access to schema private -> 42501 -> PostgREST 403/401. (Demo fault-injection fixture.)
create or replace function public.get_order_history()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform * from private.order_ledger limit 1;
end;
$$;

grant execute on function public.get_product_analytics() to anon, authenticated;
grant execute on function public.get_order_history() to anon, authenticated;
