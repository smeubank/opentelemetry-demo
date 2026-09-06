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
| product-catalog | Go | Direct Postgres, transaction pooler `:6543` (`otelsql`/libpq, `sslmode=require`) | Reads `catalog.products` |
| accounting | C#/.NET | Direct Postgres, session pooler `:5432` (EF Core / Npgsql) | Writes `accounting.order/orderitem/shipping` |

We use **direct Postgres**, not the community `supabase-go`/`supabase-csharp` client libraries —
those wrap PostgREST and would be a needless rewrite of the existing data access.

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

## PostgREST

Not used directly. `catalog.products` has an RLS `SELECT` policy for `anon`/`authenticated`, so
the frontend *could* read products through `supabase-js`/PostgREST — today it goes through the Go
product-catalog service instead. Left as a possible future surface.

## Realtime

Not used yet. Candidate: live cart/inventory updates.

## Edge Functions

**`payment-charge`** (`supabase/functions/payment-charge/index.ts`) is an opt-in Deno port of the
Node `payment` service's charge path. When `PAYMENT_EDGE_FN_URL` is set, checkout calls it over HTTP
(with the anon apikey) instead of gRPC to the local payment service; unset, the bare demo is
unchanged. It:

* validates the card (port of `src/payment/charge.js`) and persists each transaction to
  `public.transactions` via `supabase-js` (migration `0003_transactions.sql`);
* carries the **Sentry Deno SDK** (`@sentry/deno`, tracing off) and **continues the incoming W3C
  `traceparent`** (converted to Sentry's `sentry-trace`) so a Sentry issue shares the demo's
  `trace_id`. It also `console.log`s the `trace_id` — `function_edge_logs` does not parse
  `traceparent` (unlike the gateway `edge_logs`), so this makes it queryable in `function_logs`;
* can be made to fail via the **`supabasePaymentError`** flag — `invalid_token` (a blunt synthetic
  failure) or `card_format` (a realistic regression: a too-strict parser rejects validly-formatted
  dashed card numbers). Either yields a **failed checkout + Sentry issue + the
  `log_edge_function_error_rate_high` health check**, all sharing one `trace_id`.

Deploy: `supabase functions deploy payment-charge --no-verify-jwt`, set the `SENTRY_DSN` secret
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected), apply `0003`, then set
`PAYMENT_EDGE_FN_URL`. Full runbook in `supademo-readme.md`.

## Observability (Sentry + Supabase metrics)

| Piece | Where | How |
|---|---|---|
| Sentry — errors/logs/replay (frontend) | `instrumentation-client.ts`, `sentry.server/edge.config.ts` | Errors, logs, **session replay**; DSN via `window.ENV` |
| Sentry — errors/logs (backends) | Go, Python, Node, .NET, Java, Rust, PHP, Ruby services | Native SDK, DSN from env, no-op when blank |
| Sentry — traces (all services) | `otel-collector` → `otelcol-config-sentry.yml` | Collector forwards OTLP traces to Sentry's OTLP endpoint (also covers C++ currency, which has no native SDK) |
| Supabase infra metrics | `src/prometheus/supabase/`, Grafana "Supabase Project" dashboard | Prometheus scrapes the privileged metrics endpoint into the demo's own Grafana |
| Supabase log drains | — | **TODO**: skipped for now (paid plan feature) |
| Client-side trace propagation | `src/frontend/utils/supabase.ts`; `payment-charge` edge fn | `supabase-js` `tracePropagation: true` + the `/tracing` import per Supabase's [guide](https://supabase.com/docs/guides/observability/client-side-tracing). Verified end-to-end: the demo `trace_id` reaches Supabase `edge_logs`/`function_logs` and matches Jaeger |

**Sentry SDK tracing is OFF everywhere.** The SDKs handle only errors/logs/metrics/replay. There is
a single OpenTelemetry tracer per service; the collector forks those OTLP traces to **both** Jaeger
and Sentry, so traces land in Sentry without any duplicate spans. Sentry trace export is opt-in
(point `OTEL_COLLECTOR_CONFIG_EXTRAS` at `src/otel-collector/otelcol-config-sentry.yml`).

Supabase metrics are scraped by the demo's existing Prometheus (opt-in include at
`src/prometheus/supabase/supabase.yaml`, gitignored because it holds the `service_role` key —
see `supabase.yaml.example`) and shown in Grafana → **Demo → Supabase Project**.

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
2. **Read products through PostgREST.** `catalog.products` already has an `anon` read policy, so
   the frontend can read it via `supabase-js` today. Cheapest way to make RLS demonstrable rather
   than decorative. Pairs with #1.
3. **Retire `image-provider` and `astronomy-db`.** Both are redundant once Supabase is on (see
   Storage above). Route the remaining hardcoded `/images/products/…` callers through
   `getProductImageUrl()`, make the Locust Playwright predicate Supabase-aware, add a compose
   profile.
4. **Log drains** → Sentry and/or OTLP→OpenSearch
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
- **Kafka → pgmq.** Kafka is load-bearing teaching material in this demo.
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
