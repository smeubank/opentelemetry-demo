-- Deliberately-failing Data API (PostgREST) RPC used to drive Supabase's
-- `log_data_api_error_rate_high` health check from the demo's load generator.
-- ERRCODE XX000 (internal_error) makes PostgREST return HTTP 500 (a plain
-- RAISE EXCEPTION defaults to P0001 -> HTTP 400, which would not count as a 5xx).
create or replace function public.health_check_boom() returns void
  language plpgsql
as $$
begin
  raise exception 'synthetic 5xx for health-check testing' using errcode = 'XX000';
end;
$$;

grant execute on function public.health_check_boom() to anon, authenticated;
