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

## Trigger 2 — the `payment-charge` edge function (failed checkout + Sentry + health check)

The demo's payment charge path is available as an **opt-in Supabase Edge Function**
(`supabase/functions/payment-charge/index.ts`, a Deno port of `src/payment/charge.js`). When
`PAYMENT_EDGE_FN_URL` is set, checkout calls it over HTTP instead of gRPC to the local payment
service; unset, the bare demo is unchanged. The function carries the Sentry Deno SDK, **continues
the incoming W3C `traceparent`** (so its Sentry issue shares the demo's `trace_id`), and persists
each transaction to `public.transactions` via supabase-js.

**OTel span coverage vs. the local Node.js payment service:**

| Signal | Local payment (gRPC + Node) | Edge function (HTTP + Deno) |
|---|---|---|
| Server span | `oteldemo.PaymentService/Charge` (auto, gRPC) | `payment-charge` (manual OTel SDK) |
| DB write span | auto via `@opentelemetry/instrumentation-pg` | manual `db.insert transactions` span |
| DB span attributes | full query text, rows, timing | table name + transaction/card/loyalty attrs |
| PostgREST hop | n/a | invisible — supabase-js → REST → PostgREST → Postgres; only the outer HTTP call is spanned |
| Feature flag evaluation | flagd spans (auto, gRPC) | not evaluated in the edge function |

The core gap: **supabase-js goes through PostgREST (a REST API), not a direct Postgres connection**.
`@opentelemetry/instrumentation-pg` only covers direct `pg`/`postgres` driver calls; it never sees
the supabase-js HTTP request to PostgREST. The `db.insert transactions` span is manually added in
the edge function to make the DB write visible, but it has no query-level detail and no PostgREST
intermediate span. A direct connection from the edge function (via `pg` or `postgres` npm shim)
would produce the same automatic spans as the Node service — at the cost of connection management
(edge isolates do not pool connections across invocations).

The `supabasePaymentError` flag makes it fail — a **real failed checkout** that surfaces as three
correlated signals sharing one `trace_id` (a Jaeger trace, a Sentry issue, and — under load — the
`log_edge_function_error_rate_high` health check). Two modes:

- **`invalid_token`** — a blunt synthetic failure ("Payment request failed. Invalid token.").
- **`card_format`** — a *realistic regression*: a too-strict card parser that forgets to strip
  separators, so the demo's validly-formatted dashed cards (`4432-8015-6152-0454`) are wrongly
  rejected as "Credit card info is invalid." The better story for an observability-agent demo —
  the cards are valid, so the agent has to find the parser bug. The failing card is attached to the
  Sentry event for diagnosis.

**Deploy first:**

```bash
# 1. Transactions table (service role writes it; RLS on, no public policy)
#    (SQL editor, or Supabase MCP apply_migration)
psql "$SUPABASE_DB_URL_DIRECT" -f supabase/migrations/0003_transactions.sql

# 2. The edge function (verify_jwt off so checkout/load-gen call it with the apikey)
supabase functions deploy payment-charge --no-verify-jwt --project-ref <ref>

# 3. Function secret. Supabase AUTO-INJECTS SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY into every
#    edge function (used to write transactions), so only SENTRY_DSN needs setting — and it's
#    optional (unset SENTRY_DSN = no Sentry, function still works).
supabase secrets set SENTRY_DSN=<edge-function-dsn> --project-ref <ref>
```

Then in `.env.local` set
`PAYMENT_EDGE_FN_URL=https://<ref>.supabase.co/functions/v1/payment-charge`, `make redeploy
service=checkout`, and place an order.

- **Failed-checkout demo:** flip `supabasePaymentError` → `card_format` (or `invalid_token`), place
  an order → checkout returns `422 PAYMENT_FAILED` with the structured error in the UI; the same
  `trace_id` appears in Jaeger, the Sentry issue, and Supabase `function_logs`
  (`select event_message from logs where source='function_logs' and event_message like '%<trace_id>%'`
  — note function invocations land in `function_logs`/`function_edge_logs`, not `edge_logs`).
- **Health check volume:** `log_edge_function_error_rate_high` needs 5xx for ≥10% of ≥50 requests
  across two 5-min windows — more than organic checkouts produce. Hold `supabaseServiceErrors` →
  `edge_function` (or `all`) ~11 min; `SupabaseServiceErrorUser` hammers `payment-charge` with
  `injectFailure` to trip it. Needs `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` (already in `.env.local`).
- `auth` and `storage` variants are wired too, but those services mostly return **4xx** (not
  counted), so their checks likely won't fire — that's itself a finding (4xx ≠ 5xx).

## Trigger 3 — Accounting service (direct Postgres connection)

The accounting service is a .NET Kafka consumer that writes every completed order to Supabase:
`accounting."order"`, `accounting.orderitem`, and `accounting.shipping` — three tables already
created in migration `0001_init_catalog_accounting.sql`. It runs continuously alongside the load
generator, so the tables accumulate real order history.

**Why direct Postgres, not the C# Supabase SDK:**

The C# Supabase SDK (`supabase-csharp`) routes all DB calls through PostgREST — the same REST API
that supabase-js uses. This means the same OTel gap as the `payment-charge` edge function: no
auto-instrumented DB spans, only what you manually wrap.

The accounting service uses **EF Core + Npgsql** with a direct session-pooler connection, which
gives automatic OTel instrumentation via `OpenTelemetry.AutoInstrumentation` (the .NET auto-
instrumentation agent). Every `SaveChanges()` call produces SQL spans with full query text and
timing — automatically, with no manual span code.

Note: `OTEL_DOTNET_AUTO_TRACES_ENTITYFRAMEWORKCORE_INSTRUMENTATION_ENABLED=false` is set in the
compose config (upstream default), which disables the EF Core layer of instrumentation (LINQ→SQL
translation, entity-level detail). The Npgsql driver layer is independent and still fires — it
produces `postgres` spans with `db.query.text` containing the raw SQL batch sent to Postgres.

**The contrast this creates in the demo** (and why it matters for the presentation):

| Layer | Connection path | DB OTel spans |
|---|---|---|
| `payment-charge` edge function | supabase-js → PostgREST → Postgres | Manual only — table name + business attrs, no query detail |
| `accounting` service | EF Core + Npgsql → Supabase session pooler → Postgres | **Auto** — full SQL text, row count, timing per statement |

This is the same database, accessed two different ways. The auto-instrumented path (accounting)
gives Datadog-DBM-level query insight for free. The supabase-js path (payment-charge) gives nothing
without manual span code. That gap is exactly what PostgREST OTel adoption (P3 in the initiative)
would close — PostgREST emitting spans for its own SQL execution would bridge both paths.

**Setup** (already live on Hetzner — documented here for reproducibility):

```bash
# In .env.local on the server:
ACCOUNTING_DB_CONNECTION_STRING="Host=aws-0-<region>.pooler.supabase.com;Port=5432;\
Username=postgres.<ref>;Password=<password>;Database=postgres;SSL Mode=Require"
# compose.full.yaml maps this to DB_CONNECTION_STRING inside the accounting container.
```

Use the **session pooler** (port 5432), not the transaction pooler (port 6543). EF Core and Npgsql
use prepared statements which require session affinity — the transaction pooler discards prepared
statements between transactions and causes `42P05`/`26000` errors.

**Verify data is flowing:**

```sql
SELECT
  (SELECT count(*) FROM accounting."order")    AS orders,
  (SELECT count(*) FROM accounting.orderitem)  AS order_items,
  (SELECT count(*) FROM accounting.shipping)   AS shipments,
  (SELECT count(*) FROM public.transactions)   AS transactions;
```

## Health-check status observed on this project

| # | Health check | Result |
|---|---|---|
| 1 | `db_connection_limit_reached` | Reproduced real exhaustion (`53300`, even with pool auto-raised to 90) but **masked by #2's TLS failure → never fires**. |
| 2 | `db_connection_failing` | **Fires — false positive** (`SELF_SIGNED_CERT_IN_CHAIN`, load-independent); also masks #1. |
| 3 | `log_edge_function_error_rate_high` | ✅ **Fired** (~8 min) — now driven by the `payment-charge` edge function. |
| 4 | `log_data_api_error_rate_high` | Previously fired via a synthetic RPC (`health_check_boom`), now removed. No longer driven from the demo. |
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
