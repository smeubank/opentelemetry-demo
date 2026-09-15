# supabaseDatabaseBackend — runtime database switching

One flagd flag flips the demo's direct-SQL services between two deployed
Postgres backends at runtime:

- **`supabase`** (default) — the primary configured database: Supabase Postgres
  on a deployed environment.
- **`astronomy_pg`** — the demo's traditional astronomy-db Postgres, deployed
  with the `pg_tracing` extension via `compose.pg-tracing.yaml`, so queries emit
  server-side spans that stitch into the app trace.

The point is a live, side-by-side contrast in Jaeger and Sentry: the same order
flow with and without Postgres server-side spans. Decisions and learnings:
`supa-tracing-initiative/04-postgres-pg-tracing/dogfood-decisions.md`.

## Flag

`supabaseDatabaseBackend` in `src/flagd/demo.flagd.json` — variants `supabase`
(default) and `astronomy_pg`. Flip via the flagd UI (`/feature`) or by editing
the file (flagd hot-reloads).

The flag is inert unless a service has `ASTRONOMY_DB_CONNECTION_STRING`
configured. A plain clone-and-run demo has only the primary DSN (already
pointing at astronomy-db), so behavior is unchanged. This mirrors
`supabaseOrderQueueBackend`'s gating.

## Affected services

| Service | `supabase` (default) | `astronomy_pg` |
|---|---|---|
| product-catalog | primary backend: Supabase data API when `SUPABASE_URL`+key set, else primary DSN (lib/pq) | second otelsql pool on `ASTRONOMY_DB_CONNECTION_STRING`; evaluated per request in `currentStore()` |
| accounting | order writes via Npgsql/EF Core on primary DSN | per-message DSN switch in `OrderPersistence.ResolveConnectionString()` |

Interactions:

- `astronomy_pg` bypasses `supabaseAccountingBackend` (npgsql vs supabase_sdk —
  a Supabase-access-method choice) and product-catalog's data-API path.
- The pgmq order queue does not move: `PgmqConsumer` keeps polling the primary
  DSN, because the queue lives where checkout enqueues. Only the order write
  target moves with this flag.
- Both backends must hold the same schemas — `src/postgresql/init.sql` mirrors
  the Supabase `accounting` and `catalog` schemas; keep them in sync.

The chosen backend is recorded on the active span as `demo.db.backend`
(defined in `telemetry-schema/attributes/db.yaml`).

## Environment variables

Empty by default in `.env`; set in `.env.local` on deploys where the primary
DSNs point at Supabase:

```bash
PRODUCT_CATALOG_ASTRONOMY_DB_CONNECTION_STRING=postgres://astronomy_user:astronomy_password@astronomy-db/astronomy_db?sslmode=disable
ACCOUNTING_ASTRONOMY_DB_CONNECTION_STRING=Host=astronomy-db;Username=astronomy_user;Password=astronomy_password;Database=astronomy_db
```

Accounting also needs `FLAGD_HOST`/`FLAGD_PORT` (passed by
`compose.full.yaml`); without `FLAGD_HOST` the OpenFeature no-op provider
returns the `supabase` default.

## Trace-context propagation

Both direct-SQL paths append a trailing SQLCommenter comment
(`/*traceparent='00-…-01'*/`) to every statement:

- product-catalog: `otelsql.WithSQLCommenter(true)` (pre-existing).
- accounting: `TraceContextCommandInterceptor` (EF Core
  `DbCommandInterceptor`). Npgsql auto-prepare is off, so comment churn cannot
  bloat a prepared-statement cache. Caveat: the interceptor captures the parent
  activity, so pg_tracing spans appear as siblings of the Npgsql client span.

The comment is sent to both backends; Supabase ignores it today.

## Verification

1. Default-inert: plain `docker compose up`, flip the flag — nothing changes.
2. With both DSNs set, flip to `astronomy_pg`: Jaeger spans show
   `demo.db.backend=astronomy_pg` and `server.address=astronomy-db`; the
   astronomy-db `accounting."order"` row count grows while the Supabase table
   stalls.
3. With `compose.pg-tracing.yaml` active, open a checkout or product trace —
   `astronomy-db` spans (parse/plan/execute) share the app trace id.
