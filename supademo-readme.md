# Supabase health checks from the demo

Supabase's new **`health` advisor category** (service reachability, connection limits, instance
liveness, service 5xx rates) is exposed via `POST /v2/projects/{ref}/advisors/run` — **not** the
classic advisors API/MCP (security + performance only), and not yet the dashboard UI. This adds
opt-in ways to drive those conditions from the running shop, plus a curl to read the checks. With
no config the load generator is unchanged.

## Check all 10 health checks

There's no wildcard — the endpoint needs explicit lint names. These 10 are the whole HEALTH
category; anything not returned in `lints` is passing.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_xxx    # Management API PAT (Account → Access Tokens)
curl -sS -X POST https://api.supabase.com/v2/projects/<ref>/advisors/run \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"data":{"type":"project_advisors","attributes":{"lints":[
    {"name":"db_not_reachable"},{"name":"db_connection_failing"},{"name":"db_connection_limit_reached"},
    {"name":"instance_telemetry_lost"},{"name":"instance_db_down"},{"name":"instance_alert_firing"},
    {"name":"log_data_api_error_rate_high"},{"name":"log_auth_error_rate_high"},
    {"name":"log_storage_error_rate_high"},{"name":"log_edge_function_error_rate_high"}
  ]}}}' | python3 -m json.tool
```

Request/response are JSON:API-shaped (note the `data` wrapper). Body must contain ≥1 lint name.

## Trigger 1 — DB connection limit (`db_connection_limit_reached`)

A flagd flag sets how many Postgres connections the load generator holds; a dedicated Locust user
(`DatabaseExhaustionUser`) holds that many through the session pooler until refused.

Setup (`.env.local`, keyword/value form so password special chars need no url-encoding):

```
SUPABASE_DB_URL_SESSION=host=aws-0-<region>.pooler.supabase.com port=5432 dbname=postgres user=postgres.<ref> password=<raw-password> sslmode=require
```

The session pooler caps clients at `default_pool_size` (default 15), which is **below** Postgres's
`max_connections` (60), so you must first raise the pool above 60 (needs a **read-write** PAT):

```bash
curl -X PATCH https://api.supabase.com/v1/projects/<ref>/config/database/pooler \
  -H "Authorization: Bearer $RW_PAT" -H "Content-Type: application/json" \
  -d '{"default_pool_size":70}'                      # revert to 15 when done
```

Then `make start`, flip `supabaseConnectionExhaustion` → `high` (http://localhost:8080/feature/),
and read the check. Set the flag `off` and revert the pool size to recover.

> ⚠️ Finding on this project: even after genuinely exhausting Postgres (confirmed `53300 —
> remaining connection slots are reserved for roles with the SUPERUSER attribute`),
> `db_connection_limit_reached` **stays empty** — it's masked by `db_connection_failing` (below):
> the probe fails TLS before it can measure the limit.

## Trigger 2 — service 5xx (`log_*_error_rate_high`)

Drives 5xx against a chosen Supabase service so its per-service log check fires (needs a service
returning 5xx for ≥10% of ≥50 requests across two consecutive 5-minute windows). The
`SupabaseServiceErrorUser` reads `supabaseServiceErrors` (off/data_api/auth/storage/
edge_function) and hammers that service. Needs `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` (already
in `.env.local`).

**Deploy the two failing endpoints first** (the demo doesn't normally 5xx these services):

```bash
# Data API: PostgREST RPC that raises XX000 -> HTTP 500
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/migrations/0002_health_check_error_rpc.sql
#   (or run the file in the SQL editor / via the Supabase MCP apply_migration)

# Edge Function: always returns HTTP 500
supabase functions deploy health-check-error --no-verify-jwt --project-ref <ref>
#   (source: supabase/functions/health-check-error/index.ts)
```

Then flip `supabaseServiceErrors` → `data_api` or `edge_function`, let it run ~11 min
(two windows), and read `log_data_api_error_rate_high` / `log_edge_function_error_rate_high`.

- `data_api` and `edge_function` reliably produce 5xx → these checks fire.
- `auth` and `storage` are wired too, but those services mostly return **4xx** (not counted), so
  their checks likely won't fire — that's itself a finding (4xx ≠ 5xx).

## Health-check status observed on this project

| # | Health check | Result |
|---|---|---|
| 1 | `db_connection_limit_reached` | Reproduced real exhaustion (`53300`, even with pool auto-raised to 90) but **masked by #2's TLS failure → never fires**. |
| 2 | `db_connection_failing` | **Fires — false positive** (`SELF_SIGNED_CERT_IN_CHAIN`, load-independent); also masks #1. |
| 3 | `log_edge_function_error_rate_high` | ✅ **Fired** (all-mode, ~8 min) |
| 4 | `log_data_api_error_rate_high` | ✅ **Fired** (~6–8 min) |
| 5 | `log_auth_error_rate_high` | **Not triggerable** — `429`/4xx even under full DB exhaustion (GoTrue's persistent pool survives). |
| 6 | `log_storage_error_rate_high` | **Not triggerable** — `400`/4xx even under full DB exhaustion (Storage's persistent pool survives). |
| 7 | `db_not_reachable` | Not driven from the demo (needs a paused project / DNS-TCP failure). |
| 8 | `instance_telemetry_lost` | Not driven — infra-level (no metrics for 10+ min). |
| 9 | `instance_db_down` | Not driven — infra-level (`pg_up` failure). |
| 10 | `instance_alert_firing` | Not driven — infra-level (disk/IO-budget/resource alerts). |

### Probe bug worth reporting (#2 masks #1)

`db_connection_failing` false-fires on a healthy DB and, by failing the TLS handshake first, hides
`db_connection_limit_reached`. The probe verifies the DB cert against Node's default trust store,
which doesn't include Supabase's own CA:

```
openssl s_client -starttls postgres -connect aws-0-<region>.pooler.supabase.com:5432
# leaf  CN=*.pooler.supabase.com, issuer CN=Supabase Intermediate 2021 CA (O=Supabase Inc)
# Verify return code: 19 (self-signed certificate in certificate chain)
```

Since that's the standard Supabase CA, this likely false-fires fleet-wide. Fix in the probe
(`advisors-db-health`): trust the Supabase root CA or use `sslmode=require`. Not a project setting.
