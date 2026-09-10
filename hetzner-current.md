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
  -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
  up -d

# Stop
docker compose \
  -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
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

`/root/opentelemetry-demo/.env.local`:
- Supabase credentials
- `GRAFANA_PORT=3000:3000` — fixed host port binding
- `JAEGER_UI_PORT=16686:16686` — fixed host port binding
- `PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://46.225.122.52:8080/otlp-http/v1/traces` — browser-side traces use server IP not localhost

Credentials in `.env.local` — not committed.
