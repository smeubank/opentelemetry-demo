# Deploying the OTel Demo — Supabase-backed, Full OSS Stack

Live public deployment of the OTel demo with:
- **Supabase** as the Postgres backend (astronomy-db and image-provider still run but are bypassed by the branch)
- Full OSS observability: Jaeger · Prometheus · Grafana · OpenSearch
- Full demo stack: Kafka · accounting · fraud-detection · load-generator
- Tested on **Hetzner CPX32** (x86, 8 GB RAM, 4 vCPU) — ~$41.99/month

> **Cheaper when available:** Hetzner CAX31 (ARM64, 16 GB) runs ~$12.80/month and the demo
> publishes `linux/arm64` images. Check the Cost-Optimized tier in the Hetzner console — it
> frequently sells out. On 16 GB you can remove the OpenSearch heap cap from compose.override.yaml.

> **Hetzner tier naming:** "Cost-Optimized" = CX/CAX (cheapest). "Regular Performance" = CPX
> (more expensive). "General Purpose" = CCX dedicated (most expensive). Always try Cost-Optimized first.

---

## Prerequisites

### SSH key

```bash
# Check if you already have one
cat ~/.ssh/id_ed25519.pub

# If not, generate one (hit enter three times — default path, no passphrase)
ssh-keygen -t ed25519 -C "your@email.com"
cat ~/.ssh/id_ed25519.pub   # copy this output into Hetzner
```

### Hetzner account + server

1. Create account at [hetzner.com/cloud](https://hetzner.com/cloud) (your email, payment card)
2. New Project → Add Server:
   - **Location**: Nuremberg or Helsinki (try both if a tier is sold out)
   - **Image**: Ubuntu 24.04
   - **Type**: Shared Resources → Cost-Optimized (CAX31 ARM if available, else CPX32 x86)
   - **SSH keys**: paste your public key
3. Note the public IPv4 after creation

### Supabase credentials

From your Supabase project dashboard:
- **Project URL**: Settings → API → Project URL
- **Anon key**: Settings → API → `anon` `public`
- **Service role key**: Settings → API → `service_role`
- **DB password**: Settings → Database → Database password
- **DB host**: Settings → Database → Connection parameters → host

---

## Bootstrap the server

Run from your local machine — all commands go over SSH, nothing interactive:

```bash
SERVER=<YOUR_SERVER_IP>

# Accept host key automatically on first connect, then install Docker
ssh -o StrictHostKeyChecking=accept-new root@$SERVER \
  'curl -fsSL https://get.docker.com | sh'

# Install Caddy
ssh root@$SERVER '
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | \
    gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | \
    tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get -qq update && apt-get install -y -qq caddy
'

# Firewall
ssh root@$SERVER '
  ufw allow 22
  ufw allow 80
  ufw allow 443
  ufw allow 8080   # Envoy — all UIs route through here
  ufw allow 9090   # Prometheus (no Envoy path for this one)
  ufw --force enable
'
```

---

## Clone and configure

The fork (`smeubank/opentelemetry-demo`) on `supa-otel-shop` has Supabase
modifications to `product-catalog` (PostgREST data API) and `frontend` (Supabase Storage images).
Those two services use fork-built images from GHCR; everything else uses upstream images.

```bash
SERVER=<YOUR_SERVER_IP>

ssh root@$SERVER '
  git clone https://github.com/smeubank/opentelemetry-demo.git
  cd opentelemetry-demo
  git checkout supa-otel-shop
'
```

Set your values locally, then write `.env.local` to the server in one step.
Note: pipe a local heredoc into ssh so variables expand on your machine before being sent.

```bash
SERVER=<YOUR_SERVER_IP>
SUPABASE_REF=<your-project-ref>        # e.g. poevzlmscrydhaytrwjx
SUPABASE_ANON_KEY=<anon key jwt>
SUPABASE_SERVICE_ROLE_KEY=<service role key jwt>
DB_PASSWORD=<your db password>         # URL form: percent-encode special chars (* → %2A)
DB_HOST=<pooler host>                  # e.g. aws-0-eu-central-1.pooler.supabase.com
DB_USER=postgres.${SUPABASE_REF}

ssh root@$SERVER "cat > /root/opentelemetry-demo/.env.local" << EOF
SUPABASE_URL=https://${SUPABASE_REF}.supabase.co
SUPABASE_PUBLISHABLE_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_STORAGE_BUCKET=product-images
SUPABASE_STORAGE_BASE_URL=https://${SUPABASE_REF}.supabase.co/storage/v1/object/public/product-images
PRODUCT_CATALOG_DB_CONNECTION_STRING=postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/postgres?sslmode=require
ACCOUNTING_DB_CONNECTION_STRING=Host=${DB_HOST};Port=5432;Username=${DB_USER};Password=${DB_PASSWORD};Database=postgres;SSL Mode=Require
# Port bindings — compose.observability.yaml uses bare port numbers (e.g. "3000") which Docker
# assigns ephemeral host ports. HOST:CONTAINER format forces fixed bindings.
# These HOST:CONTAINER values are only for Docker port mapping; the Envoy cluster config
# uses hardcoded internal ports (3000, 16686) so Envoy's uint32 validation is not affected.
# Do NOT add JAEGER_GRPC_PORT — Jaeger uses that var as its own listen address and
# HOST:CONTAINER format (e.g. "4317:4317") breaks its startup with "too many colons".
GRAFANA_PORT=3000:3000
JAEGER_UI_PORT=16686:16686
# The browser-side OTel SDK sends traces to this URL. Must be the server's public IP —
# "localhost" in this context resolves to the visitor's machine, not the server.
PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://${SERVER}:8080/otlp-http/v1/traces
EOF
```

> **DB password special characters:** percent-encode in the URL connection string only
> (`*` → `%2A`, `@` → `%40`, `#` → `%23`). The `.NET` `ACCOUNTING_DB_CONNECTION_STRING`
> takes the raw password — no encoding needed there.

---

## Compose override

```bash
GITHUB_OWNER=smeubank   # change this if you move the repo to a different org

ssh root@$SERVER "cat > /root/opentelemetry-demo/compose.override.yaml" << EOF
services:
  # Fork images for the two services with Supabase changes.
  # Everything else uses upstream ghcr.io/open-telemetry/demo images.
  product-catalog:
    image: ghcr.io/${GITHUB_OWNER}/opentelemetry-demo:latest-product-catalog
  frontend:
    image: ghcr.io/${GITHUB_OWNER}/opentelemetry-demo:latest-frontend
  grafana:
    deploy:
      resources:
        limits:
          memory: 350M
  opensearch:
    environment:
      - OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m
  frontend-proxy:
    volumes:
      - ./src/frontend-proxy/envoy.tmpl.yaml:/home/envoy/envoy.tmpl.yaml
EOF
```
> Set `GITHUB_OWNER` to wherever the repo lives. The CI workflow derives the same value
> automatically from `github.repository_owner`, so both stay in sync when the repo moves.

> **Grafana memory:** the default 175M limit causes 503 errors under normal load. 350M is stable on
> an 8 GB server; bump to 512M+ if you see 503s or OOM kills in the logs.

> **OpenSearch heap cap:** only needed on 8 GB servers. On 16 GB+ you can omit the opensearch
> block entirely and let it use its default (50% of available RAM).

> **Envoy volume mount:** the branch includes two patches to the upstream `envoy.tmpl.yaml` that
> are needed when deploying with external port bindings like `GRAFANA_PORT=3000:3000`:
> 1. Grafana/Jaeger cluster ports are hardcoded (`3000`, `16686`) so the `HOST:CONTAINER` value
>    in `GRAFANA_PORT` / `JAEGER_UI_PORT` doesn't break Envoy's uint32 port validation.
> 2. The `/grafana/` route has `upgrade_configs: websocket` so Grafana Live works through the proxy.
> The volume mount ensures the running container uses the patched template instead of the baked-in one.

> **Why astronomy-db and image-provider still run:** Docker Compose rejects
> `profiles: ["disabled"]` on services that others depend on — `frontend` depends on
> `image-provider`, `product-catalog` depends on `astronomy-db`. They start but are bypassed
> by the Supabase integration on this branch.

---

## Start the stack

```bash
ssh root@$SERVER '
  cd /root/opentelemetry-demo
  docker compose --env-file .env --env-file .env.local \
    -f compose.yaml \
    -f compose.full.yaml \
    -f compose.observability.yaml \
    -f compose.override.yaml \
    up -d
'
```

First run pulls ~28 images — allow 5–10 minutes. Check progress:

```bash
ssh root@$SERVER 'docker ps --format "table {{.Names}}\t{{.Status}}"'
```

---

## Verify

All UIs route through the Envoy proxy on port 8080. Hitting Grafana or Jaeger on their direct
ports (3000, 16686) causes wrong redirects — always use the paths below.

| URL | What you should see |
|---|---|
| `http://<ip>:8080` | Storefront — browse and buy |
| `http://<ip>:8080/grafana/` | Grafana dashboards (admin / admin on first login) |
| `http://<ip>:8080/jaeger/ui/` | Jaeger traces — note the required `/ui/` suffix (Jaeger v2) |
| `http://<ip>:8080/loadgen/` | Locust load generator UI |
| `http://<ip>:8080/feature` | flagd feature flag toggles |
| `http://<ip>:8080/telemetry/` | Telemetry docs |
| `http://<ip>:9090` | Prometheus (redirects to /graph — normal) |
| Supabase dashboard | product-catalog queries visible in DB logs |

---

## With a domain + HTTPS (Caddy)

Point an A record at the server IP, then:

```bash
ssh root@$SERVER "cat > /etc/caddy/Caddyfile" << EOF
demo.yourdomain.com {
    reverse_proxy localhost:8080
}
EOF
systemctl reload caddy
```

Everything (Grafana, Jaeger, Locust, etc.) is then accessible as paths under the domain —
e.g. `https://demo.yourdomain.com/grafana/`. Do not add separate Caddy routes for individual
services pointing to ports 3000 or 16686 — that bypasses Envoy and breaks Grafana/Jaeger routing.

---

## Stop / start

```bash
SERVER=<YOUR_SERVER_IP>

# Stop
ssh root@$SERVER '
  cd /root/opentelemetry-demo
  docker compose --env-file .env --env-file .env.local \
    -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
    down
'

# Start
ssh root@$SERVER '
  cd /root/opentelemetry-demo
  docker compose --env-file .env --env-file .env.local \
    -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
    up -d
'
```

---

## CI/CD — automatic deploy on push

`.github/workflows/deploy-hetzner.yml` builds the two fork-modified images and deploys on every
push to `supa-otel-shop` that touches `src/product-catalog/`, `src/frontend/`,
`src/frontend-proxy/envoy.tmpl.yaml`, or `supabase/`. It can also be triggered manually from the
Actions tab (`workflow_dispatch`).

### One-time setup (manual — do this once, then CI is fully automatic)

**1. Allow Actions to push packages**

Settings → Actions → General → Workflow permissions → select **Read and write permissions** → Save

**2. Add two repository secrets**

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | How to get it |
|---|---|
| `HETZNER_SSH_KEY` | `cat ~/.ssh/id_ed25519` — the private key (starts with `-----BEGIN OPENSSH PRIVATE KEY-----`) |
| `GHCR_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate → tick `read:packages` only |

After these two steps, every push to `supa-otel-shop` that touches the paths above triggers a
full build + deploy automatically. Nothing else is required.

### What the workflow does

1. **Build** — compiles and pushes `latest-product-catalog` and `latest-frontend` to
   `ghcr.io/smeubank/opentelemetry-demo` in parallel (~5 min, cached after first run)
2. **Deploy** — SSHes into Hetzner, runs `git pull` to pick up source changes (e.g. Envoy config,
   Supabase functions), then `docker compose pull` + `up -d --no-deps` for only the two services

Only those two containers restart; Kafka, observability stack, and all other services keep running.

### Manual deploy (no CI)

```bash
SERVER=<YOUR_SERVER_IP>

ssh root@$SERVER '
  cd /root/opentelemetry-demo
  git fetch origin supa-otel-shop && git reset --hard origin/supa-otel-shop
  docker compose --env-file .env --env-file .env.local \
    -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
    pull product-catalog frontend
  docker compose --env-file .env --env-file .env.local \
    -f compose.yaml -f compose.full.yaml -f compose.observability.yaml -f compose.override.yaml \
    up -d --no-deps product-catalog frontend
'
```

---

## Pause billing (snapshot + delete)

Powered-off servers still bill on Hetzner. To truly pause:

1. Hetzner console → your server → **Snapshots** → Take snapshot (~$2/month storage)
2. **Delete** the server — billing stops immediately
3. To resume: New Server → from snapshot (new IP assigned — update DNS/bookmarks)

---

## Costs

| Option | RAM | Monthly |
|---|---|---|
| Hetzner CAX31 ARM (preferred, often sold out) | 16 GB | ~$12.80 |
| Hetzner CPX32 x86 (tested, currently available) | 8 GB | ~$41.99 |
| + Supabase free tier | — | $0 |
| + IPv4 address | — | $0.60 |
