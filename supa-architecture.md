# Deployed architecture — current state

Everything running on the Hetzner deployment (`supa-otel-shop`, all compose
layers: full + observability + pg-tracing + Supabase via `.env.local`). Two flagd
flags move data paths at runtime; everything else is static.

```mermaid
flowchart LR
  subgraph shop [Astronomy Shop services]
    fw[frontend-web browser]
    fp[frontend-proxy Envoy]
    fe[frontend]
    pc[product-catalog]
    co[checkout]
    acc[accounting]
    fd[fraud-detection]
    lg[load-generator]
    flagd[flagd + flagd-ui]
  end

  subgraph supabase [Supabase cloud]
    rest[PostgREST data API]
    spg[(Supabase Postgres + pgmq queues)]
    edge[payment-charge edge fn]
    slogs[Supabase logs]
  end

  subgraph localdb [Self-hosted]
    adb[(astronomy-db PG16 + pg_tracing)]
    kafka[(Kafka)]
  end

  subgraph otel [OTel stack self-hosted]
    col[otel-collector]
    jaeger[Jaeger v2 all-in-one: OTLP in + in-memory store + UI]
    prom[(Prometheus)]
    os[(OpenSearch logs)]
    graf[Grafana]
  end

  sentry[Sentry per-service projects incl. otel-shop-astronomy-db-postgres]

  fw --> fp --> fe
  fe --> pc & co
  lg --> fp
  pc -- "flag supabaseDatabaseBackend = supabase (default)" --> rest --> spg
  pc -- "= astronomy_pg" --> adb
  co -- "flag supabaseOrderQueueBackend = pgmq (default)" --> spg
  co -- "= kafka" --> kafka
  co --> edge
  spg -- "pgmq poll" --> acc & fd
  kafka --> acc & fd
  acc -- "order writes: supabase (default)" --> spg
  acc -- "= astronomy_pg" --> adb
  flagd -.-> pc & co & acc

  shop -- "OTLP traces/metrics/logs" --> col
  adb -- "pg_tracing spans OTLP HTTP" --> col
  col -- "postgresql + pgmq metrics scrape" --> adb & spg
  col --> jaeger
  col -- "metrics (incl. spanmetrics)" --> prom
  col -- logs --> os
  col -- "routing connector per service.name" --> sentry
  graf --> jaeger & prom & os
  edge -. "trace_id in logs only (no OTLP route back)" .-> slogs
```

## What the trace backend actually is

There is no separate trace database. **Jaeger v2 all-in-one is the trace
backend**: the collector forwards OTLP to it, it stores traces in an in-memory
store (`MEMORY_MAX_TRACES=25000` — ephemeral, lost on container restart), and
serves its own query UI. Grafana's trace views read from Jaeger. Long-lived
signals are elsewhere: metrics in Prometheus (including span-derived RED metrics
via the collector's spanmetrics connector), logs in OpenSearch, and the Sentry
copy of the traces in Sentry's cloud.

## The two runtime flags

| Flag | Default | Moves |
|---|---|---|
| `supabaseOrderQueueBackend` | `pgmq` | checkout's order hand-off: Supabase Queues vs Kafka (consumers run both; see supa-pgmq-kafka.md) |
| `supabaseDatabaseBackend` | `supabase` | product-catalog reads + accounting order writes: Supabase Postgres vs the pg_tracing-enabled astronomy-db (see supa-db-backend.md) |

## Postgres tracing path

astronomy-db (PG 16, `compose.pg-tracing.yaml`) emits server-side spans —
statement, Planner, ExecutorRun, plan nodes, commit — via pg_tracing's native
OTLP HTTP exporter straight to the collector, stitched to app traces by the
SQLCommenter `traceparent` both direct-SQL services send. From the collector they
fan out like any other spans: Jaeger, spanmetrics→Prometheus, and Sentry (routed
to the dedicated postgres project). Supabase's Postgres cannot emit these spans
today — that contrast is the point of the dogfood
(supa-tracing-initiative project 4).
