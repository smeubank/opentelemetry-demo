# The PostgREST instrumentation gap (OpenTelemetry)

Moving `product-catalog` from a direct Postgres connection (`otelsql`/`libpq`) to Supabase's **data
API** (PostgREST over HTTP, via the community `supabase-go` client) fixed the transaction-pooler
prepared-statement failures — but it silently dropped the client-side **`db` span** that used to
carry the actual SQL. This is **not a Supabase quirk**; it's a **PostgREST-ecosystem instrumentation
gap** that OpenTelemetry does not cover in any language yet.

The gap has **two complementary sides**, and it's worth pursuing both upstream:

- **Central / server-side (the more complete fix):** PostgREST itself emits OTel spans and propagates
  trace context. This already has maintainer interest — **PostgREST issue
  [#3118](https://github.com/PostgREST/postgrest/issues/3118)** is an open umbrella tracking issue for
  OTel that explicitly lists span instrumentation, **trace-context propagation ("handle and propagate
  trace ID")**, and **database query instrumentation (wrapping `hasql`)** — i.e. the real SQL, in the
  same trace. Supabase is just one wrapper around PostgREST, so a fix here benefits everyone.
- **Client-side / per-SDK:** an OTel instrumentation that recognizes PostgREST calls and emits
  `db`-semconv spans "as observed by the caller" — useful even when the server isn't instrumented.

## What we lost, and why

- With `otelsql`, each query emitted a CLIENT `db` span: `db.system=postgresql`, `db.query.text=<SQL>`.
- With the data API, the client makes an HTTP call to PostgREST and **the SQL is synthesized
  server-side** from the URL. The client only ever knows the *PostgREST query* — table, `select`,
  and filters (`id=eq.X`) — never the SQL text. So even ideal client instrumentation can describe the
  query *intent*, not `db.query.text`.
- Incidentally, `supabase-go` isn't `otelhttp`-wrapped and exposes no client hook, so today there
  isn't even an **HTTP client span** — the data-API call is currently invisible in the trace (only the
  gRPC server span remains).

## Why existing OTel tools don't cover it

- `otelsql` / `instrumentation-pg` instrument **direct** DB drivers — gone the moment you use the data API.
- `otelhttp` instruments HTTP generically, but yields a plain HTTP span with **no db semantics**, and
  isn't wired into the SDK today.
- **No OTel instrumentation understands PostgREST** — the registry has none, client- or server-side.
  Server-side native OTel is *tracked but unshipped* (PostgREST
  [#3118](https://github.com/PostgREST/postgrest/issues/3118)).
- Contrast Sentry: its `supabaseIntegration` reconstructs `db` spans by wrapping the JS client at
  runtime (monkeypatch). Go can't monkeypatch → it needs explicit instrumentation; and even in JS,
  OTel has no native equivalent.

## This is a gap across ALL our SDKs, not just Go

| Surface | Client | DB span today |
|---|---|---|
| product-catalog | Go / `supabase-go` | none (no `otelhttp` hook) |
| frontend, payment-charge | JS / `supabase-js` | none from OTel; Sentry's `supabaseIntegration` gives a partial one |
| (future) other services | Python / `supabase-py`, etc. | same gap |
| accounting | .NET / Npgsql (direct Postgres) | real `db` spans — **unaffected** |

Anyone using **PostgREST directly** (no Supabase) has the identical gap — which is exactly why the
fix belongs in the **PostgREST + OTel ecosystem**, not in a Supabase-specific wrapper. Supabase is
just one (large) wrapper around PostgREST.

## PostgREST is detectable — the signals

An instrumentation can recognize a PostgREST call and enrich the span from the response (verified
against our project):

- **`Content-Location: /products?id=eq.OLJCESPC7Z&select=id`** — PostgREST echoes the query back
  (table + filters + select). A high-fidelity source for a `db` span.
- **`Content-Profile: catalog`** — the schema.
- **`Content-Range: 0-0/*`** — PostgREST's pagination marker.
- **`Server: postgrest/<version>`** — present on **direct** PostgREST, but **overwritten to
  `cloudflare`** behind Supabase's gateway — so don't rely on `Server` there; the `Content-*` headers
  survive.

## The fix, in layers

- **(a) HTTP client span — cheapest.** `otelhttp` on the SDK's client → an `HTTP GET /rest/v1/products?…`
  span whose URL carries the table + filters. Needs a client-injection point the community SDK doesn't
  expose today (and **no official Supabase Go SDK exists yet** —
  <https://github.com/orgs/supabase/discussions/49311>). Serviceable, but it's an HTTP span, not a `db` span.
- **(b) PostgREST-semantic span — the real fix.** A PostgREST-aware OTel instrumentation that maps the
  request / `Content-Location` to **db semconv**: `db.system.name=postgresql`,
  `db.collection.name=<table>`, `db.operation.name=<select|insert|…>`, `db.query.text` = the PostgREST
  filter (normalized). Emitted client-side, per language. **Does not exist for any language today.**
- **(c) The literal SQL — server-side only.** Two ways: (i) **PostgREST emits OTLP spans** honoring
  the incoming `traceparent` → a *server* `db` span with the real SQL in the same trace. This is
  exactly the scope of PostgREST **[#3118](https://github.com/PostgREST/postgrest/issues/3118)** (span
  instrumentation + trace propagation + `hasql` query instrumentation), and Supabase's Kong gateway
  already speaks OTel. (ii) **out-of-band** — the SQL is in Supabase `postgres_logs`, and since we
  already propagate `trace_id` into those logs, you can join logs→trace by `trace_id`. Works today
  with zero new instrumentation.

## The layer below: Postgres emits no spans either

Even the server-side fix has a floor. **Postgres itself produces no OTel spans** — our old `db` spans
came entirely from the *client driver* (`otelsql`), which is exactly what the data API removed. At the
database layer you get:

- **Metrics, not spans.** "Monitor Postgres with OTel" in practice means the Collector's **`postgresql`
  receiver** scraping `pg_stat_*` → metrics only, no spans / no SQL / no trace context (e.g. [this
  walkthrough](https://pradumnasaraf.dev/blog/monitor-your-postgresql)). We already scrape equivalent
  infra metrics from Supabase's own metrics endpoint, so this doesn't touch the span gap.
- **Spans from *inside* Postgres** need the **[`pg_tracing`](https://github.com/DataDog/pg_tracing)**
  extension (SQLCommenter-driven, honors the incoming `traceparent`). It is **not in Supabase's
  extension catalog** — so this route is closed on managed Supabase today.
- **What Supabase does expose here:** `pg_stat_statements` (installed) and `postgres_logs` — the SQL
  text and execution stats as *data*, not spans. Joined with the `trace_id` we already propagate,
  that's the out-of-band correlation (layer c-ii) — and, given the two points above, the **only
  realistic path on managed Supabase today**.

So the SQL span is missing at *both* server layers on Supabase: PostgREST ([#3118](https://github.com/PostgREST/postgrest/issues/3118))
is unshipped, and `pg_tracing` isn't offered. That's the real state of the gap.

## The upstream direction (central first)

1. **Server-side OTel — the central fix, at two layers.**
   (a) **PostgREST** ([#3118](https://github.com/PostgREST/postgrest/issues/3118)) honors the incoming
   `traceparent` and emits spans (incl. the `hasql` DB query with the real SQL);
   (b) **Postgres** via `pg_tracing` emits query-execution spans continuing the same trace.
   Together they'd run one trace caller → PostgREST → Postgres. Both are Supabase-independent and
   ecosystem-wide — but **on managed Supabase today neither is available** (#3118 unshipped,
   `pg_tracing` not offered), so the practical Supabase answer is the `pg_stat_statements` /
   `postgres_logs` ↔ `trace_id` correlation until they land.
2. **Client-side PostgREST instrumentation for OTel**, per language, detectable via the `Content-*`
   headers above (layer b). Complements #1 with caller-side `db` spans and works even against an
   uninstrumented server. Start with Go + JS (our surfaces).
3. **Interim (this repo):** demo the **`postgres_logs` ↔ `trace_id`** correlation (layer c-ii) as the
   stopgap, and wire `otelhttp` (layer a) as soon as a client hook exists.

## Open questions to take to OTel / PostgREST / Supabase

- **semconv:** is the data API a "database" (`db.*`) surface or an HTTP/RPC one? Likely `db.*` with
  `db.system.name=postgresql`, noting the call is via PostgREST.
- **PII:** filters can carry sensitive values (`email=eq.…`) → a redaction policy for `db.query.text`.
- **Client vs server** instrumentation (do both; only the server has the SQL).
- **Detection behind gateways** (Cloudflare strips `Server`; rely on `Content-Profile`/`Content-Range`/`Content-Location`).
- **Coordination:** PostgREST maintainers, Supabase client-SDK teams, and the OTel semconv +
  instrumentation SIGs.

## References

- **PostgREST #3118 — OpenTelemetry umbrella issue** (span instrumentation, trace propagation, hasql
  query instrumentation): <https://github.com/PostgREST/postgrest/issues/3118>
- OTel — database client semantic conventions: <https://opentelemetry.io/docs/specs/semconv/db/database-spans/>
- OTel — PostgreSQL semantic conventions: <https://opentelemetry.io/docs/specs/semconv/db/postgresql/>
- OTel — instrumentation libraries: <https://opentelemetry.io/docs/concepts/instrumentation/libraries/>
- `@opentelemetry/instrumentation-pg` (direct driver, for contrast): <https://www.npmjs.com/package/@opentelemetry/instrumentation-pg>
- `pg_tracing` — spans from inside Postgres (SQLCommenter/traceparent; not on Supabase): <https://github.com/DataDog/pg_tracing>
- OTel Collector `postgresql` receiver (metrics only): <https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/postgresqlreceiver>
- "Monitor your PostgreSQL with OpenTelemetry" (metrics-only walkthrough, for contrast): <https://pradumnasaraf.dev/blog/monitor-your-postgresql>
- Self-hosted Supabase + OTel (gateway speaks OTel): <https://www.supascale.app/blog/opentelemetry-for-selfhosted-supabase-distributed-tracing-gu>
- Official Supabase Go SDK discussion: <https://github.com/orgs/supabase/discussions/49311>
