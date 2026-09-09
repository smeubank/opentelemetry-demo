# pg_tracing / PostgREST OTel Instrumentation Gap — Consolidated Context

Pulled together for EPD project scoping. Combines: (1) the external technical writeup on the
PostgREST instrumentation gap, (2) internal Slack history on `pg_tracing`, and (3) related
Linear/Notion references.

---

## 1. External reference doc: "The PostgREST instrumentation gap (OpenTelemetry)"

Source: [smeubank/opentelemetry-demo — supa-instrumentation-gap.md](https://github.com/smeubank/opentelemetry-demo/blob/supa-otel-shop/supa-instrumentation-gap.md) (branch `supa-otel-shop`)

**Core problem:** Moving a service from a direct Postgres connection (`otelsql`/`libpq`) to
Supabase's data API (PostgREST over HTTP) fixes transaction-pooler prepared-statement issues, but
silently drops the client-side `db` span that used to carry the actual SQL. Framed as a
**PostgREST-ecosystem gap**, not a Supabase-specific one — OTel has no instrumentation for this in
any language yet.

**Two complementary fix paths identified:**
- **Server-side (more complete):** PostgREST itself emits OTel spans + propagates trace context.
  Tracked upstream in **[PostgREST #3118](https://github.com/PostgREST/postgrest/issues/3118)**
  (umbrella issue: span instrumentation, trace-context propagation, and wrapping `hasql` for real
  SQL text).
- **Client-side / per-SDK:** an OTel instrumentation that recognizes PostgREST calls (via
  `Content-Location`, `Content-Profile`, `Content-Range` response headers — `Server` header is
  overwritten to `cloudflare` behind Supabase's gateway, so it's not usable as a detection signal)
  and emits `db`-semconv spans from the caller side, even without server instrumentation.

**Why existing tools don't cover it:** `otelsql`/`instrumentation-pg` need a direct DB driver;
`otelhttp` gives a generic HTTP span with no db semantics; no OTel instrumentation understands
PostgREST today (client or server). Contrast: Sentry's `supabaseIntegration` reconstructs `db`
spans by monkeypatching the JS client at runtime — not possible in Go, and OTel has no native
equivalent even in JS.

**Layered fix framing (from the doc):**
| Layer | Description | Status |
|---|---|---|
| (a) HTTP client span | `otelhttp` wraps the SDK client → HTTP span with table/filters in URL | Cheapest; needs a client-injection point current community SDKs don't expose (no official Supabase Go SDK yet — [discussion #49311](https://github.com/orgs/supabase/discussions/49311)) |
| (b) PostgREST-semantic span | Maps `Content-Location` etc. to `db.*` semconv, client-side, per language | Does not exist for any language today |
| (c-i) Literal SQL, server-side | PostgREST emits OTLP spans honoring incoming `traceparent` | Scope of PostgREST #3118 — unshipped |
| (c-ii) Literal SQL, out-of-band | SQL lives in Supabase `postgres_logs`; join by `trace_id` already propagated | **Works today, zero new instrumentation — the only realistic path on managed Supabase right now** |

**The layer below — Postgres itself emits no spans:**
- The OTel Collector's `postgresql` receiver only scrapes `pg_stat_*` → metrics, no spans/SQL/trace
  context.
- Spans *from inside* Postgres require the **`pg_tracing`** extension (SQLCommenter/`traceparent`-driven) — **and it is explicitly noted as not in Supabase's extension catalog**, closing that route on managed Supabase today.
- What Supabase does expose: `pg_stat_statements` + `postgres_logs` as *data*, joinable to `trace_id` — the (c-ii) out-of-band correlation, which the doc calls the only realistic path today.

**Recommended upstream direction (per the doc):**
1. Server-side OTel at two layers — PostgREST (#3118) + Postgres (`pg_tracing`) — would together give one trace: caller → PostgREST → Postgres. Neither is available on managed Supabase today.
2. Client-side PostgREST instrumentation per language (start with Go + JS), detectable via the `Content-*` headers.
3. Interim (in that repo): demo the `postgres_logs` ↔ `trace_id` correlation, and add `otelhttp` once a client hook exists.

**Open questions raised:** whether the data API is a `db.*` surface or HTTP/RPC surface for
semconv purposes; PII redaction policy for `db.query.text` (filters can carry values like
`email=eq.…`); doing both client- and server-side instrumentation; detection behind gateways that
strip the `Server` header; and coordination across PostgREST maintainers, Supabase SDK teams, and
OTel semconv/instrumentation SIGs.

**All references cited in the doc:**
- [PostgREST #3118 — OTel umbrella issue](https://github.com/PostgREST/postgrest/issues/3118)
- [OTel database client semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/database-spans/)
- [OTel PostgreSQL semantic conventions](https://opentelemetry.io/docs/specs/semconv/db/postgresql/)
- [OTel instrumentation libraries](https://opentelemetry.io/docs/concepts/instrumentation/libraries/)
- [`@opentelemetry/instrumentation-pg`](https://www.npmjs.com/package/@opentelemetry/instrumentation-pg)
- [`pg_tracing` (DataDog)](https://github.com/DataDog/pg_tracing)
- [OTel Collector `postgresql` receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/postgresqlreceiver)
- ["Monitor your PostgreSQL with OpenTelemetry"](https://pradumnasaraf.dev/blog/monitor-your-postgresql)
- [Self-hosted Supabase + OTel](https://www.supascale.app/blog/opentelemetry-for-selfhosted-supabase-distributed-tracing-gu)
- [Official Supabase Go SDK discussion #49311](https://github.com/orgs/supabase/discussions/49311)

---

## 2. `pg_tracing` itself

Source: [DataDog/pg_tracing](https://github.com/DataDog/pg_tracing) — "Distributed Tracing for
PostgreSQL." PostgreSQL extension, early development / may be unstable, supports **PG 14, 15, 16
only** currently.

- Generates server-side spans on sampled queries for planner/executor/utility statements,
  execution-plan nodes, nested queries, triggers, parallel workers, and transaction commit (WAL
  fsync time).
- Two trace-context propagation mechanisms:
  1. **SQLCommenter** (SQL comment) — but invalidates prepared statements.
  2. **`pg_tracing.trace_context` GUC**, set via `SET LOCAL` inside a transaction — does **not**
     invalidate prepared statements, which is why it's the mechanism of interest internally.
- Can send spans directly to an OTel collector via `pg_tracing.otel_endpoint` (background worker,
  configurable interval).
- Requires `shared_preload_libraries` + a server restart, and additional shared memory proportional
  to `pg_tracing.max_span` (consumed whenever loaded, even with no spans generated).

---

## 3. Internal Slack history on `pg_tracing`

**Main thread — #initiative-self-debugging**, Feb 1–3, 2026 (root: [Paul Copplestone shares the HN thread](https://news.ycombinator.com/item?id=46804009) on pg_tracing):

- **Michał Kłeczek** first surfaced it in **#team-data-api**: "Guys, today I learned about
  pg_tracing" — excited specifically about the `trace_context` GUC route: "Having e2e observability
  down to the db would be so awesome!"
- **Steve Chavez** confirmed the GUC approach avoids the SQLCommenter prepared-statement problem
  (transaction variable instead of a SQL comment).
- **Steven (you)** dropped in [pg_tracing GitHub issue #86](https://github.com/DataDog/pg_tracing/issues/86)
  and commented that the ecosystem likely needs more vendors pushing the agenda — drawing a parallel
  to OTel/TC-39 spec-body dynamics, where there aren't enough proactive members driving things
  forward.
- **Chase Granberry** raised the core blocker: getting a trace ID that correlates PostgREST ↔
  Postgres without unwanted tradeoffs; also floated whether spans could show up in `auto_explain`
  logs even without the extension installed.
- **Michał** noted `pg_tracing`'s OTel-endpoint option would let Postgres spans flow into the same
  collector as PostgREST spans → downstream to Logflare, and separately suggested PostgREST's own
  OTel PR ([postgrest#3140](https://github.com/PostgREST/postgrest/pull/3140)) could add
  trace-context passing via `pg_tracing.trace_context`.

**Follow-up in #team-data-api**, March + June 2026:
- Michał revisited the idea, pointing to a draft PostgREST PR
  ([#4666](https://github.com/PostgREST/postgrest/pull/4666)) for passing tracing context from HTTP
  headers into a GUC variable — still dependent on the broader OTel work landing.
- He asked whether to open an upstream PostgREST issue specifically for this.
- Also linked: [PostgREST OTel adoption Linear project](https://linear.app/supabase/project/postgrest-opentelemetry-adoption-cdf9aa99c69b/overview)
  (referenced by Steve Chavez when looping in Laurence Isla for help pushing it).

---

## 4. Related Linear items

No Linear project is dedicated to `pg_tracing` itself. It sits adjacent to / referenced from:

- **[PostgREST: context propagation on SQL statements (query tags)](https://linear.app/supabase/project/52fd1a47-025a-47b2-ac6a-7439b19841b8)**
  — owned by Steve Chavez, status "Open for comments," progress 0.5. Directly relevant: this is the
  query-tagging / trace-context problem `pg_tracing`'s GUC mechanism would help solve.
  - **[DAT-45 — PostgREST: implement query tags](https://linear.app/supabase/issue/DAT-45/posgrest-implement-query-tags)**
    (Steve Chavez): documents that dynamic query tags à la Fauna were investigated and ruled out
    (invalidates prepared statements), and that `pg_stat_monitor` doesn't work as advertised either.
- **[SDK-1211 — Propagate trace context through `ctx.postgres` queries](https://linear.app/supabase/issue/SDK-1211/propagate-trace-context-through-ctxpostgres-queries)**
  (Katerina Skroumpelou, `@supabase/server`, Backlog): wrap `ctx.postgres` queries with OTel spans
  using the existing `@supabase/tracing` pattern from `supabase-js` — client-side layer, same
  problem space as the external doc's "layer (b)."
- **PostgREST OTel adoption** — [Linear project](https://linear.app/supabase/project/postgrest-opentelemetry-adoption-cdf9aa99c69b/overview),
  referenced in Slack as the tracking project for pushing PostgREST's native OTel support forward
  (maps to upstream **PostgREST #3118**).
- **Feedback Intake tickets** showing recurring customer demand for exactly this gap:
  - [FDBKIN-35096 — Propagate request trace ID into Postgres logs and Edge Functions for end-to-end tracing](https://linear.app/supabase/issue/FDBKIN-35096/propagate-request-trace-id-into-postgres-logs-and-edge-functions-for) (Triage)
  - [FDBKIN-13892 — Clarify how to trace requests end-to-end across Postgres and Edge Functions](https://linear.app/supabase/issue/FDBKIN-13892/clarify-how-to-trace-requests-end-to-end-across-postgres-and-edge) (Triage)
  - [FDBKIN-28384 — Add OpenTelemetry export for pg_flight_recorder to integrate with APMs](https://linear.app/supabase/issue/FDBKIN-28384/add-opentelemetry-export-for-pg-flight-recorder-to-integrate-with-apms) (Triage) — adjacent ask, different tool but same "get Postgres-side spans into an APM" motivation.

---

## 5. Synthesis for EPD scoping

Putting the external doc and internal history side by side:

- **The external doc independently arrives at the same two blockers the Slack thread identified
  seven months ago:** PostgREST needs to emit spans + propagate trace context (#3118, still
  unshipped), and Postgres-level spans require `pg_tracing`, which **is not in Supabase's extension
  catalog**. Both routes are still closed on managed Supabase today.
- **The only working path today, per both sources, is the out-of-band correlation**: `postgres_logs`
  (or `pg_stat_statements`) joined to `trace_id` that's already propagated — i.e., no new
  instrumentation needed, but it's log-correlation rather than a real span tree. This lines up with
  the existing "correlated logs" work already in Q4 scope.
- **Internal momentum exists but is fragmented:** the query-tags project (DAT-45 / Steve Chavez),
  SDK-1211 (client-side `ctx.postgres` spans), and the PostgREST OTel adoption project are all
  pieces of the same puzzle but aren't currently linked to each other or to a single owning
  initiative.
- **Open decision for the EPD project:** whether to (a) push on the PostgREST-side fix upstream
  (#3118 / #3140 / #4666 — ecosystem-wide, benefits everyone, but Supabase doesn't control the
  timeline), (b) formally evaluate adding `pg_tracing` to the extension catalog (Postgres-side fix,
  gated by the fact it only supports PG 14–16 and is still "early development / may be unstable"),
  and/or (c) invest in client-side per-SDK PostgREST instrumentation (Go + JS first, per the
  external doc) as a Supabase/community contribution to OTel that doesn't require waiting on either
  upstream.
