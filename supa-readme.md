# Supabase integration

This fork runs the OpenTelemetry Astronomy Shop on **Supabase** — Postgres for all SQL, Auth for
sign in, Storage for product images, and Supabase's infra metrics wired into the demo's
observability stack.

The goal is a **dogfooding environment**: a realistic, multi-service app backed by Supabase, so we
can learn what a more complex customer setup looks like end to end — and how you'd properly monitor
and debug it with a range of popular tools and open standards (OpenTelemetry, Jaeger, Prometheus,
Grafana, OpenSearch, and Sentry).

Everything is **opt-in and env-gated**: with no config the shop runs exactly as upstream — bundled
Postgres, bundled image server, anonymous users, external monitoring off.

## Run it

```bash
# Original demo, no accounts needed:
docker compose up            # or: make start

# With Supabase + Sentry:
cp .env.local.example .env.local   # fill in your values
make start                         # .env.local is loaded last and overrides .env
```

`.env.local` is gitignored. It overrides the placeholder defaults in `.env`. See
`.env.local.example` for the full list of variables.

### Enable hosted Supabase — shortlist

1. Create (or open) a Supabase cloud project. From **Project Settings** collect: the pooler
   connection strings, the `service_role` key, and the publishable (`sb_publishable_…`) key.
2. `cp .env.local.example .env.local` and fill in `PRODUCT_CATALOG_DB_CONNECTION_STRING`
   (transaction pooler `:6543`), `ACCOUNTING_DB_CONNECTION_STRING` (session pooler `:5432`),
   `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_STORAGE_BASE_URL`, and the `SENTRY_*` values.
3. Apply `supabase/migrations/0001_init_catalog_accounting.sql` to the project (Supabase CLI/MCP
   or `psql`). Create a **public** `product-images` bucket and upload
   `src/image-provider/static/products/*`.
4. For Supabase infra metrics, copy `src/prometheus/supabase/supabase.yaml.example` to
   `supabase.yaml` and fill in the project ref + `service_role` key.
5. For Sentry **traces** (optional), set `OTEL_COLLECTOR_CONFIG_EXTRAS` to
   `./src/otel-collector/otelcol-config-sentry.yml` plus `SENTRY_OTLP_ENDPOINT` /
   `SENTRY_OTLP_PUBLIC_KEY`.
6. For the **`payment-charge` edge function** (optional), apply `0003_transactions.sql`,
   `supabase functions deploy payment-charge --no-verify-jwt`, `supabase secrets set SENTRY_DSN=…`,
   and set `PAYMENT_EDGE_FN_URL`. Full runbook in `supademo-readme.md`.
7. `make start`.

### Local URLs to check out

Everything is served through the frontend-proxy on **`:8080`** (except Prometheus, published
directly). Handy links after `make start`:

| What | URL |
|---|---|
| Web store (frontend) | http://localhost:8080/ |
| Sign in (magic link) | http://localhost:8080/login |
| Feature flags UI | http://localhost:8080/feature/ |
| Load generator (Locust) | http://localhost:8080/loadgen/ |
| Jaeger (traces) | http://localhost:8080/jaeger/ui/ |
| Grafana | http://localhost:8080/grafana/ |
| → **Supabase Project dashboard** | http://localhost:8080/grafana/d/d402d94e-da48-48e4-ac52-53026b96a004/supabase-project |
| Prometheus | http://localhost:9090/ |

External SaaS: **Sentry** (your project → Issues / Replays / Traces) and the **Supabase**
dashboard (Database / Auth / Storage / Reports).

The tables below are grouped by the Supabase (or observability) product surface, and say how
each service talks to it.

---

## Postgres

Default is the bundled `astronomy-db`. Set the two connection strings in `.env.local` to point at
Supabase instead — no code changes. Schema + seed live in
`supabase/migrations/0001_init_catalog_accounting.sql` (RLS on; app roles bypass it).

| Service | Language | How it connects | What it does |
|---|---|---|---|
| product-catalog | Go | ~~Direct Postgres, transaction pooler `:6543` (`otelsql`/libpq)~~ — **opted out** (kept as fallback) | Reads `catalog.products` |
| product-catalog | Go | **Data API** via the community `supabase-go` SDK (PostgREST); opt-in with `SUPABASE_URL`+key (see PostgREST) | Reads `catalog.products` |
| accounting | C#/.NET | Direct Postgres, session pooler `:5432` (EF Core / Npgsql) | Writes `accounting.order/orderitem/shipping` |

product-catalog left direct `libpq` because the **transaction pooler (`:6543`)** doesn't support
prepared statements — which `libpq` always uses for parameterized queries and (unlike pgx/Prisma/etc.)
can't disable ([Supabase docs](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL),
no Go entry). Under concurrency it failed with `unnamed prepared statement does not exist`, masked as
gRPC `NOT_FOUND` and cascading to cart/checkout. `accounting` is fine on the **session pooler
(`:5432`)** (dedicated backend per connection).
The `libpq` path stays as the fallback (bundled DB, no accounts). See also the transaction-pooler
[caveat](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Auth

| Service | Language | How it connects | What it does |
|---|---|---|---|
| frontend | Next.js / TS | `@supabase/supabase-js` (browser client, session in `localStorage`) | Magic-link (email OTP) sign in at `/login` |

Logged-in users get their Supabase `user.id` mapped into the existing session, which already
flows to cart and checkout. Anonymous browsing still works when signed out (a new UUID is
issued). No `@supabase/ssr`/cookies — the browser client's localStorage session matches the
demo's existing session model.

> Config note: add your shop origin to **Auth → URL Configuration → Redirect URLs** in the
> Supabase dashboard so magic links return to the app.

## Storage

| Service | Language | How it connects | What it does |
|---|---|---|---|
| frontend | Next.js / TS | Public bucket URLs (`imageLoader.js`, `utils/imageUrl.ts`) | Serves product images from the `product-images` bucket |

Enabled by setting `NEXT_PUBLIC_SUPABASE_STORAGE_BASE_URL`. When unset, images fall back to the
bundled `image-provider`. The bundled provider keeps running either way (it's part of the demo's
Nginx telemetry), but product images point at Supabase when configured.

### Redundant services when Supabase is on

Two bundled services become redundant once Supabase is enabled (both left running today; candidates
for a compose profile that skips them):

- **`image-provider`** — with `SUPABASE_STORAGE_BASE_URL` set, product-detail images come from
  Supabase Storage via `getProductImageUrl()` (`src/frontend/utils/imageUrl.ts`), but cart /
  checkout / order components (`CartDropdown.tsx`, `CartItem.tsx`, `CheckoutItem.tsx`,
  `pages/cart/checkout/[orderId]/index.tsx`) and the Locust Playwright task still hardcode
  `/images/products/…` (routed by `src/frontend-proxy/envoy.tmpl.yaml` to `image-provider:8081`),
  so both image sources run in parallel. To drop it: route those through `getProductImageUrl()`,
  make the Playwright predicate Supabase-aware, and add a compose profile.
- **`astronomy-db`** (bundled Postgres) — redundant when the Supabase connection strings are set.

## PostgREST (data API)

`product-catalog` reads `catalog.products` through the **data API** (via the community `supabase-go`
client), opt-in with `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` — the fix for the pooler bug above,
and it makes RLS load-bearing (the `anon` `SELECT` policy is what authorizes the read). Adds two
surfaces: the Go SDK and the data API.

**Setup:** expose the `catalog` schema (Settings → API → Exposed schemas, or `PATCH .../postgrest`
`db_schema="public,graphql_public,catalog"`) and grant the anon role read on it (`GRANT USAGE ON
SCHEMA catalog` + `GRANT SELECT ON catalog.products`, both in `0001_init_catalog_accounting.sql`).

> `supabase-go` is the **community** SDK; switch to the official Go SDK when it ships
> ([discussion](https://github.com/orgs/supabase/discussions/49311)) — should also close the
> product-catalog trace-propagation gap (see Observability).

## Realtime

Not used yet. Candidate: live cart/inventory updates.

## Queues (pgmq)

An opt-in **Supabase Queues (pgmq)** backend for the order flow (`checkout` → `accounting` +
`fraud-detection`), running *alongside* Kafka. The headline is that **Supabase carries a real
message-queue workload**, not just CRUD Postgres: the same database backing the catalog and
accounting tables also transports the order events across three services and two languages —
something people usually stand up a dedicated broker for.

`checkout` JSON-encodes each `OrderResult` into an envelope
(`{ "traceparent": ..., "order": {...} }`) and `pgmq.send`s it to **two queues**
(`orders_accounting`, `orders_fraud` — one per consumer, reproducing Kafka's independent consumer
groups). `accounting` (Npgsql poller) and `fraud-detection` (JDBC poller) each `pgmq.read` their
queue, continue the trace from the envelope `traceparent`, process, then `pgmq.delete`. All
connections use the **session pooler (`:5432`)** because the pollers issue prepared statements.

Kafka stays the out-of-the-box default. When checkout is configured with a pgmq connection, the
`supabaseOrderQueueBackend` flag flips the two at runtime — which doubles as the **secondary
teaching payload: a side-by-side instrumentation contrast**. Kafka gives fully auto-instrumented
messaging spans (semconv across Go/.NET/Kotlin) + `kafkametrics`; pgmq has no messaging
auto-instrumentation, so producer/consumer spans are hand-written while the underlying SQL still
yields `db` spans for free, and queue depth comes from a `sqlquery` receiver over
`pgmq.metrics_all()`.

**Enable it:** apply `supabase/migrations/0004_pgmq_queues.sql`, set the pgmq vars in `.env.local`
(`QUEUE_PGMQ_ENABLED=true` + the session-pooler connection strings — see `.env.local.example`), and
run with `-f compose.pgmq.yaml` added for queue-depth metrics. Full design, decisions, and
functional trade-offs in **[supa-pgmq-kafka.md](supa-pgmq-kafka.md)**.

## Edge Functions

**`payment-charge`** (`supabase/functions/payment-charge/index.ts`) is an opt-in Deno port of the
Node `payment` service's charge path. When `PAYMENT_EDGE_FN_URL` is set, checkout calls it over HTTP
(with the anon apikey) instead of gRPC to the local payment service; unset, the bare demo is
unchanged. It:

* validates the card (port of `src/payment/charge.js`) and persists each transaction to
  `public.transactions` via `supabase-js` (migration `0003_transactions.sql`);
* carries the **Sentry Deno SDK** (`@sentry/deno`, tracing enabled at 1.0) and **continues the
  incoming W3C `traceparent`** (converted to Sentry's `sentry-trace`) so a Sentry transaction and
  issue share the demo's `trace_id`. Unlike other services, Sentry tracing is on here because the
  edge function can't reach the local OTLP collector — Sentry is the only tracer available. It also `console.log`s the `trace_id` — `function_edge_logs` does not parse
  `traceparent` (unlike the gateway `edge_logs`), so this makes it queryable in `function_logs`;
* can be made to fail via the **`supabasePaymentError`** flag — `invalid_token` (a blunt synthetic
  failure) or `card_format` (a realistic regression: a too-strict parser rejects validly-formatted
  dashed card numbers). Either yields a **failed checkout + Sentry issue + the
  `log_edge_function_error_rate_high` health check**, all sharing one `trace_id`.

Deploy: `supabase functions deploy payment-charge --no-verify-jwt`, set the `SENTRY_DSN` secret
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected), apply `0003`, then set
`PAYMENT_EDGE_FN_URL`. Full runbook in `supademo-readme.md`.

## Observability

The demo ships the **full OpenTelemetry pipeline out of the box**: every service emits **traces,
metrics, and logs** over OTLP to the **collector**, which fans them out to **Jaeger** (traces),
**Prometheus** (metrics), **OpenSearch** (logs), and **Grafana** (dashboards). That baseline needs
no accounts and is what runs on a plain `docker compose up`.

This integration layers a few things on top of that baseline:

| Addition | Where | How |
|---|---|---|
| Supabase infra metrics | `src/prometheus/supabase/`, Grafana → **Demo → Supabase Project** | Prometheus scrapes the project's privileged metrics endpoint into the demo's own Grafana (opt-in include `supabase.yaml`, gitignored — holds the `service_role` key, see `.example`) |
| Supabase logs (edge / postgres / function) | Supabase dashboard, `query_logs` MCP | Where the propagated `trace_id` lands — see below |
| Sentry (opt-in error monitoring) | native SDKs per service + a collector fork | one *additional* destination; details below |
| Supabase log drains | — | **TODO** (paid-plan feature) |

**Sentry is one opt-in destination, not the headline.** When a DSN is set, each service's native
Sentry SDK reports **errors/logs** (and browser **session replay**) with **its own tracing OFF** —
OpenTelemetry stays the single tracer. The collector additionally forks the same OTLP traces to
Sentry (opt-in: point `OTEL_COLLECTOR_CONFIG_EXTRAS` at `otelcol-config-sentry.yml`; also covers C++
currency, which has no native SDK). An empty DSN turns Sentry off entirely and changes nothing about
the OTel pipeline above.

### Trace propagation into Supabase logs

Getting one `trace_id` to span the app **and** Supabase's own logs takes a slightly different trick
per service — each talks to Supabase differently, and Supabase captures the trace differently per
surface:

- **frontend (browser)** — `supabase-js` `tracePropagation: true` + `import '@supabase/supabase-js/tracing'` (`src/frontend/utils/supabase.ts`) injects W3C `traceparent` on auth/data calls.
- **load-generator (Python)** — `RequestsInstrumentor` auto-injects `traceparent` on its `requests` calls to Supabase.
- **checkout → payment-charge (Go)** — an `otelhttp`-wrapped client propagates `traceparent` over the HTTP charge call.
- **payment-charge edge fn (Deno)** — converts the incoming `traceparent` to Sentry's `sentry-trace` (so the Sentry issue shares the id) **and** `console.log`s the `trace_id`, because `function_edge_logs` doesn't parse `traceparent` (below).
- **product-catalog (Go, data API)** — reads via `supabase-go`; the community SDK doesn't expose its HTTP client, so `traceparent` isn't injected today (**known limitation** — the gRPC spans still show in Jaeger). The deeper gap — that the data API loses the client-side SQL `db` span entirely — is written up in **[supa-instrumentation-gap.md](supa-instrumentation-gap.md)** (a PostgREST-ecosystem OTel gap worth taking upstream).

The asymmetry worth knowing: the API gateway's **`edge_logs`** auto-parses `traceparent` into a
queryable `log_attributes['trace_id']`, but **`function_edge_logs` does not** — so edge functions log
the `trace_id` themselves. Verified end-to-end for the load-gen and edge-function paths (`trace_id`
matches across Jaeger, Sentry, and Supabase logs).

**Edge functions don't reach the collector.** `payment-charge` runs on Supabase's infra, which can't
route to the demo's local `otel-collector` — so it exports **no OTLP** and is **not a service in
Jaeger**. Jaeger shows only the caller-side `checkout → POST payment-charge` client span; the trace is
stitched across Jaeger + Sentry + Supabase logs by the shared `trace_id`, not by the function emitting
spans. (A public collector endpoint / OTLP tunnel would be needed to get real edge-fn spans.)

### Enabling source maps (Sentry, frontend)

De-minified stack traces need a source-map upload at build time. Set `SENTRY_AUTH_TOKEN` (and
`SENTRY_ORG`/`SENTRY_PROJECT`) and build the frontend; without a token, upload is skipped and the
build is unaffected.

---

## TODO

Remaining Supabase surfaces, ranked by whether they're actually worth doing.

### Worth doing

1. **Make RLS real.** The three `accounting` tables have RLS enabled but zero policies, and no
   backend ever sees a Supabase JWT — the frontend maps `user.id` into localStorage and passes a
   bare string to cart and checkout. Forward the access token and write ownership policies so Auth
   enforces something instead of just labelling the session.
2. **Switch to the official Go SDK.** product-catalog now reads products through PostgREST via the
   **community** `supabase-go` SDK (see the PostgREST section). Move to the **official Supabase Go
   SDK** once it ships ([discussion](https://github.com/orgs/supabase/discussions/49311)); that
   should also let us inject an `otelhttp` client so product-catalog's data-API calls carry
   `traceparent` (today's known gap).
3. **Close the PostgREST OTel gap (upstream).** The data API loses the client-side SQL `db` span in
   every language, not just Go — see **[supa-instrumentation-gap.md](supa-instrumentation-gap.md)**.
   Track PostgREST [#3118](https://github.com/PostgREST/postgrest/issues/3118) (server-side native
   OTel) and consider a client-side PostgREST instrumentation; interim, demo the `postgres_logs` ↔
   `trace_id` correlation.
4. **Retire `image-provider` and `astronomy-db`.** Both are redundant once Supabase is on (see
   Storage above). Route the remaining hardcoded `/images/products/…` callers through
   `getProductImageUrl()`, make the Locust Playwright predicate Supabase-aware, add a compose
   profile.
5. **Log drains** → Sentry and/or OTLP→OpenSearch
   ([docs](https://supabase.com/docs/guides/observability/log-drains)). Paid plan.

### Worth a look

5. **Cart off Valkey.** `ValkeyCartStore` already sits behind an `ICartStore` interface, so a
   second implementation is a contained change, and carts are durable data users expect to survive.
   Two ways to do it: hosted Postgres (one fewer container, though a worse fit than Redis for hot
   cart reads), or [`@supabase/lite`](https://www.npmjs.com/package/@supabase/lite) as a sidecar in
   place of `valkey-cart`. Lite is PostgREST + GoTrue compatible on SQLite, so the KV surface
   becomes Supabase-shaped without requiring a hosted project, which keeps the zero-config default
   intact. It's alpha, and the C# service would talk to it over PostgREST rather than the Redis
   protocol.
6. **Agent chat history in Postgres.** `src/agent` (opt-in via `compose.agent.yaml`) is stateless:
   the browser re-posts the whole `history` array every turn and the server keeps nothing. A
   LangGraph Postgres checkpointer makes chats survive a reload, which is a real user-facing
   feature rather than plumbing, and it gives the agent a Supabase table it genuinely reads and
   writes. Only pays off if the agent stack is part of the demo.
7. **Realtime for order/shipping status.** The one Realtime use case here that isn't contrived.

### Low value

On the list deliberately, but none of these earn their cost today:

- **Edge Functions for currency conversion.** Edge Functions are now realized via the opt-in
  `payment-charge` function (see above); currency specifically stays put — it's the one C++/gRPC
  service, and that's the point of it.
- **flagd flags in Postgres.** Static JSON by design; a table plus a sync path buys no new insight.
- **`recommendation` cache / `ad` map in Postgres.** In-memory by design. pgvector on
  `recommendation` would be a new feature, not a migration.

### Non-Supabase

- Native **C++ currency** error capture in Sentry (its traces already reach Sentry via the collector; `sentry-native` would add crash/error events).

---

## A note on Sentry

Sentry is a detail, not the point. The demo already ships an OpenTelemetry-native observability
stack (Jaeger for traces, Prometheus + Grafana for metrics, OpenSearch for logs). Sentry was added
alongside it purely to have a second, comparable **error-monitoring and tracing** product in the
mix — so the dogfooding environment reflects how a real Supabase-backed app might be observed with
more than one tool, and so the two approaches can be compared side by side. It stays fully additive:
Sentry never takes over tracing (that remains OpenTelemetry → Jaeger), and with a blank DSN it is
simply off.
