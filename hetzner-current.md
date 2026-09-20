# Hetzner Deployment — Current State

**Server:** ubuntu-8gb-nbg1-1  
**IP:** 46.225.122.52  
**Spec:** CPX32 · x86 · 4 vCPU · 8 GB RAM · 160 GB SSD · Nuremberg  
**Branch:** supa-otel-shop  

---

## Links

All UIs go through the Envoy proxy on port 8080. Direct service ports (3000, 16686) are open
but hitting them directly gives wrong redirects — use the paths below.

| Service | URL | Status |
|---|---|---|
| **Storefront** | http://46.225.122.52:8080 | ✓ |
| **Grafana** (dashboards) | http://46.225.122.52:8080/grafana/ | ✓ admin / admin |
| **Jaeger** (traces) | http://46.225.122.52:8080/jaeger/ui/ | ✓ |
| **Locust** (load generator) | http://46.225.122.52:8080/loadgen/ | ✓ |
| **Feature flags** (flagd UI) | http://46.225.122.52:8080/feature | ✓ |
| **Telemetry docs** | http://46.225.122.52:8080/telemetry/ | ✓ |
| **Prometheus** | http://46.225.122.52:9090 | ✓ (direct, redirects to /graph) |

---

## Start / stop

```bash
# SSH in
ssh root@46.225.122.52

# Start
cd /root/opentelemetry-demo
docker compose --env-file .env --env-file .env.local \
  -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.pg-tracing.yaml -f compose.override.yaml \
  up -d

# Stop
docker compose \
  -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.pg-tracing.yaml -f compose.override.yaml \
  down

# Status
docker ps --format "table {{.Names}}\t{{.Status}}"
```

## Pause billing (snapshot + delete)

```bash
# 1. Hetzner console → Servers → ubuntu-8gb-nbg1-1 → Snapshots → Take snapshot
# 2. Delete the server — billing stops immediately
# 3. To resume: New Server → from snapshot (new IP assigned)
```

Snapshot storage: ~$0.012/GB/month (~$2/month while paused).

---

## Active overrides

`/root/opentelemetry-demo/compose.override.yaml`:
- OpenSearch heap capped at 512 MB (fits 8 GB server)
- Grafana and Jaeger bound to fixed host ports (3000, 16686)

`compose.pg-tracing.yaml` (committed): astronomy-db runs PG 16 with the pg_tracing
extension instead of the default POSTGRES_IMAGE — the image is built locally
(`docker compose ... build astronomy-db` before first start). See
supa-tracing-initiative/04-postgres-pg-tracing/dogfood-decisions.md.

Deploy notes (from the 2026-09-15 pg_tracing rollout):

- Full sequence: `git pull`, append the two astronomy DSNs to `.env.local`, then
  `docker compose <full file list> build astronomy-db accounting product-catalog`
  followed by `up -d`. astronomy-db has no data volume, so recreation reruns
  `init.sql` + `zz-pg-tracing.sql` cleanly.
- **Collector configs are bind-mounted and NOT hot-reloaded** — after changing any
  `otelcol-config-*.yml`, `up -d` alone does not recreate the container (config
  isn't part of the compose hash). Run
  `docker compose <file list> restart otel-collector` explicitly, or new routing
  (e.g. the astronomy-db → Sentry entry) silently never loads.
- `docker exec product-catalog env` fails (scratch-based image, no coreutils) —
  use `docker inspect product-catalog --format '{{json .Config.Env}}'` instead.
- pg_tracing spans land in the Sentry project's **Trace Explorer / spans dataset**
  (`span.op: default`), not in transaction-based views — `sentry trace list`
  and the project's Performance/Traces pages show nothing even when ingestion
  works. Find them under **Explore → Traces** (org level, filter
  `project:otel-shop-astronomy-db-postgres`), by opening a stitched trace from
  any app project's trace waterfall, or via the events API (`dataset=spans`).
- **flagd is the same bind-mount gotcha as the collector**: a long-running flagd
  container does not reliably reload `demo.flagd.json` after `git pull` — new
  flags simply don't appear in the UI. Restart it:
  `docker compose <file list> restart flagd flagd-ui`.
- flagd-ui flag flips **write to the checked-out `src/flagd/demo.flagd.json`**,
  leaving the git tree dirty on the server — `git checkout -- src/flagd/demo.flagd.json`
  (or stash) before the next `git pull`, or the pull fails on conflict.

`/root/opentelemetry-demo/.env.local`:
- Supabase credentials
- `GRAFANA_PORT=3000:3000` — fixed host port binding
- `JAEGER_UI_PORT=16686:16686` — fixed host port binding
- `PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://46.225.122.52:8080/otlp-http/v1/traces` — browser-side traces use server IP not localhost
- `PRODUCT_CATALOG_ASTRONOMY_DB_CONNECTION_STRING=postgres://astronomy_user:astronomy_password@astronomy-db/astronomy_db?sslmode=disable` — secondary astronomy-db DSN for the supabaseDatabaseBackend flag
- `ACCOUNTING_ASTRONOMY_DB_CONNECTION_STRING=Host=astronomy-db;Username=astronomy_user;Password=astronomy_password;Database=astronomy_db` — same, Npgsql keyword form

Credentials in `.env.local` — not committed.

---

## Claude Code / AI-native interface

The Supabase MCP is a hosted HTTP server — no need to clone this repo. Anyone
with project access can point their own Claude Code at it directly.

**Setup (one time, in any project or globally):**

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=poevzlmscrydhaytrwjx&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching%2Cstorage"
    }
  }
}
```

Then open Claude Code — it will prompt for OAuth. Log in with a Supabase account
that has access to project `poevzlmscrydhaytrwjx`. Done.

**What this unlocks against the deployed stack:**

- Query and introspect `astronomy_db` (PG 16 + pg_tracing) directly in conversation
- Fetch Supabase project logs to correlate with Jaeger traces and Sentry span data
- Inspect edge functions, storage, and connection pooler state
- Ask "why are pg_tracing spans missing from the collector?" and Claude can query the DB, check logs, and read the schema without leaving the chat
