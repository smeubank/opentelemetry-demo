create extension if not exists pg_cron;

-- Rolling history of relation sizes; the observability routine reads this to compute % growth
-- per window (substitute for the cancelled db_disk_exhaustion_forecast advisor).
create table if not exists public.table_size_history (
  captured_at   timestamptz not null default now(),
  schema_name   text not null,
  table_name    text not null,
  total_bytes   bigint not null,
  table_bytes   bigint not null,
  index_bytes   bigint not null,
  row_estimate  bigint not null
);
create index if not exists table_size_history_captured_at_idx
  on public.table_size_history (captured_at desc);

-- product_view_events is an append-only telemetry table with no retention policy — a realistic
-- unbounded-growth source. record_product_views() appends view events; under load with no
-- pruning it grows fast, which the routine flags as >=10% growth in a short window.
create table if not exists public.product_view_events (
  id          bigserial primary key,
  product_id  text not null,
  session_id  uuid not null default gen_random_uuid(),
  payload     text not null,
  created_at  timestamptz not null default now()
);

create or replace function public.record_product_views(n integer)
returns void language sql security invoker set search_path = public as $$
  insert into public.product_view_events (product_id, payload)
  select
    (array['0PUK6V6EV0','1YMWWN1N4O','2ZYFJ3GM2N','66VCHSJNUP','OLJCESPC7Z'])[1 + (g % 5)],
    repeat('x', 1024)
  from generate_series(1, greatest(n, 0)) g;
$$;
grant execute on function public.record_product_views(integer) to anon, authenticated;

-- Snapshot all user tables on a SHORT interval for the demo (every minute).
-- For a real project, schedule this hourly instead.
select cron.schedule(
  'snapshot-table-sizes',
  '* * * * *',
  $$
  insert into public.table_size_history
    (schema_name, table_name, total_bytes, table_bytes, index_bytes, row_estimate)
  select
    n.nspname, c.relname,
    pg_total_relation_size(c.oid), pg_relation_size(c.oid),
    pg_indexes_size(c.oid), c.reltuples::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p')
    and n.nspname not in ('pg_catalog','information_schema','cron')
    and n.nspname not like 'pg_toast%'
  $$
);
