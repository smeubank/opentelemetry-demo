# Gap: Sentry error not linked to OTel trace

## What you see

A Sentry issue exists (e.g.
[#7715573613](https://steven-eubank.sentry.io/issues/7715573613/?project=4512027274117120))
with a full stack trace showing a checkout/payment failure. The same Jaeger trace ID
(`e7bee9df9a6d20d9a8e1b477721bb2e5`) has a complete span waterfall across frontend → checkout.
In Sentry's trace explorer, those spans are connected. But the issue page shows **no linked
trace**, and the payment-charge edge function does not appear in the Jaeger trace at all.

## Root cause

The edge function never emits OTel spans. It only runs the Sentry SDK, which sends Sentry-format
transactions directly to Sentry's ingest. Two things follow from this:

1. **Jaeger sees nothing from the edge function** — the collector never receives spans with
   `service.name = "payment"` (or "payment-charge") from Supabase, so the Jaeger trace ends at
   the checkout service's outgoing HTTP span.

2. **Sentry error ↔ trace link is broken** — the Sentry error event is captured by the Next.js
   frontend SDK when checkout returns a failure. At that moment Sentry tries to attach the
   current OTel trace context. The OTel span (from `chargeCardViaEdge`'s `otelhttp` client) is
   still active in the checkout service (Go), but by the time the error surfaces in Next.js it
   may be in a different async scope where the OTel span context is no longer active. Sentry emits
   the error without a `trace_id` → no link.

The edge function itself is reachable. The checkout service (`chargeCardViaEdge`) correctly
injects `traceparent` via the `otelhttp` transport on its HTTP client. The edge function receives
the header, converts it to Sentry's `sentry-trace` format via `sentryTraceFromTraceparent`, and
calls `Sentry.continueTrace()` — so the Sentry SDK side is wired. The OTel side is missing
entirely.

## The fix (in progress)

Add the OTel SDK to the edge function:
- `@opentelemetry/sdk-trace-base` + `@opentelemetry/exporter-trace-otlp-http` (fetch-based,
  works in Deno) configured to export to the public OTLP endpoint on Hetzner
- `service.name = "payment"` so the routing connector in `otelcol-config-sentry.yml` sends spans
  to `traces/sentry_payment` (Sentry) and the main pipeline sends them to Jaeger — no config
  change needed
- `W3CTraceContextPropagator.extract()` continues the parent trace from the `traceparent` header
- After creating the OTel span, set `Sentry.getCurrentScope().setPropagationContext({ traceId,
  spanId })` so error events carry the same `trace_id` as the OTel spans
- `await otelProvider.forceFlush()` before returning the response (edge isolates freeze on
  response; `BatchSpanProcessor.forceFlush()` actually waits for the OTLP fetch to complete)
- `OTEL_EXPORTER_OTLP_ENDPOINT` as a Supabase secret pointing to
  `http://46.225.122.52:8080/otlp-http/v1/traces`

## Side topic: what Sentry + Supabase could do better

Orthogonal to OTel: Sentry should surface signals that are today invisible for edge functions
deployed on Supabase:

- **Cold-start latency** — every Supabase function isolate initialization emits a `booted (time:
  Xms)` log entry in `function_logs` (observed: 99ms, 120ms). This boot cost is invisible to
  Sentry: the Sentry transaction starts after boot, so the booted time is lost from the performance
  profile. Sentry shows a `payment-charge` span of N ms, but the real wall-clock time from the
  caller's perspective is N + boot_ms. The gap is the difference. For cold-start aborts (OOM,
  resource limit, deploy race), neither Sentry nor OTel sees anything — only Supabase gateway logs.
- **Auth rejections** — requests rejected by Supabase before the function runs (invalid JWT,
  missing API key) produce a 401/403 at the gateway layer. The function never executes and Sentry
  never captures anything.
- **Network-level timeouts** — if the caller (checkout service) times out waiting for the edge
  function response, the function may still be running. The caller's Sentry event says "timeout"
  but there is no signal about what the function was doing at that moment.

All three cases produce a Sentry error in the caller with no matching event in the callee's Sentry
project, and no span in the trace. A Sentry ↔ Supabase integration could surface these via
Supabase gateway events forwarded to Sentry as "infrastructure spans" — similar to how Vercel's
Sentry integration surfaces edge function cold-start and timeout metadata.

Worth raising with the Sentry team as a partnership opportunity.

## Related

- `supa-instrumentation-gap.md` — PostgREST/Postgres OTel span gap
- `pg-tracing-postgrest-otel-context.md` — deeper context on pg_tracing and query tags
- `supa-tracing-initiative/initiative.md` — P2 (SDK trace-context propagation), P6 (Edge)
- FDBKIN-35096: Propagate request trace ID into Postgres logs and Edge Functions
