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
6. `make start`.

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

Not used yet. Candidate: move a stateless service (e.g. currency conversion) to an Edge Function.

## Observability (Sentry + Supabase metrics)

| Piece | Where | How |
|---|---|---|
| Sentry — errors/logs/replay (frontend) | `instrumentation-client.ts`, `sentry.server/edge.config.ts` | Errors, logs, **session replay**; DSN via `window.ENV` |
| Sentry — errors/logs (backends) | Go, Python, Node, .NET, Java, Rust, PHP, Ruby services | Native SDK, DSN from env, no-op when blank |
| Sentry — traces (all services) | `otel-collector` → `otelcol-config-sentry.yml` | Collector forwards OTLP traces to Sentry's OTLP endpoint (also covers C++ currency, which has no native SDK) |
| Supabase infra metrics | `src/prometheus/supabase/`, Grafana "Supabase Project" dashboard | Prometheus scrapes the privileged metrics endpoint into the demo's own Grafana |
| Supabase log drains | — | **TODO**: skipped for now (paid plan feature) |
| Client-side trace propagation | frontend | Relies on the existing OTel fetch instrumentation; explicit config per Supabase's [client-side tracing guide](https://supabase.com/docs/guides/observability/client-side-tracing) is a **TODO** |

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

- Supabase **log drains** → Sentry and/or OTLP→OpenSearch ([docs](https://supabase.com/docs/guides/observability/log-drains)).
- Native **C++ currency** error capture in Sentry (its traces already reach Sentry via the collector; `sentry-native` would add crash/error events).
- Explicit **Supabase client-side trace propagation** so supabase-js calls appear as spans in Jaeger.
- Optional surfaces: **Realtime**, **Edge Functions**, reading products via **PostgREST**.

---

## A note on Sentry

Sentry is a detail, not the point. The demo already ships an OpenTelemetry-native observability
stack (Jaeger for traces, Prometheus + Grafana for metrics, OpenSearch for logs). Sentry was added
alongside it purely to have a second, comparable **error-monitoring and tracing** product in the
mix — so the dogfooding environment reflects how a real Supabase-backed app might be observed with
more than one tool, and so the two approaches can be compared side by side. It stays fully additive:
Sentry never takes over tracing (that remains OpenTelemetry → Jaeger), and with a blank DSN it is
simply off.
