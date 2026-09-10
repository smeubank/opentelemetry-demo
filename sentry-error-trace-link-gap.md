# Gap: Sentry error not linked to OTel trace

## What you see

A Sentry issue exists (e.g.
[#7715573613](https://steven-eubank.sentry.io/issues/7715573613/?project=4512027274117120))
with a full stack trace showing a checkout/payment failure. The same Jaeger trace ID
(`e7bee9df9a6d20d9a8e1b477721bb2e5`) has a complete span waterfall across frontend → checkout →
payment-charge. In Sentry's trace explorer, all spans are connected. But the issue page shows
**no linked trace** — you cannot click from the error into the trace, and the trace does not
appear in the "Traces" tab of the issue.

## Why this happens

The demo uses two separate pipelines into Sentry:

| Pipeline | Path | Who sets `trace_id` |
|---|---|---|
| **Errors** | Next.js Sentry SDK (`onRequestError`, `captureException`) → `https://…ingest.sentry.io` | Sentry SDK reads from the active OTel context |
| **Traces** | OTel collector → OTLP routing → `https://…ingest.sentry.io/api/…/integration/otlp` | OTel span's W3C `trace_id` |

For the error and the trace to be linked in Sentry's UI, the `trace_id` attached to the Sentry
error event must match the `trace_id` of the OTLP spans. That requires the OTel span to be
**active in the same async context** when the Sentry SDK captures the error.

In the checkout-failure scenario the span tree looks like this:

```
browser (OTel)
  └─ POST /api/checkout  (Next.js server — OTel + Sentry SDK)
       └─ gRPC → checkout service (Go, OTel only)
            └─ HTTP POST → payment-charge (Supabase Edge Function, Deno Sentry SDK)
                 └─ supabase-js insert → Supabase Postgres
```

The checkout service (Go) makes the HTTP call to the Supabase edge function and gets a 500. It
propagates the error back to Next.js via gRPC. Next.js's `onRequestError` captures the error. At
that point the active OTel context is the `/api/checkout` server span — which IS the right
trace. But `@sentry/nextjs` with `skipOpenTelemetrySetup: true` reads the OTel context via the
OTel global API. If the gRPC response handling resolves in an async tick where the OTel span
context has been lost (propagation gap across the gRPC boundary or an untraced async boundary),
Sentry gets no trace context and emits the error event without a `trace_id`.

The result: Sentry has the error. Sentry has the trace (via OTLP). It cannot join them because
the error event's `trace_id` field is empty or wrong.

## The Supabase-specific angle

This case involves the edge function **not being reached** (or failing immediately). When the
payment-charge function is unreachable, the Go checkout service times out or gets a network
error before the Supabase edge runtime even logs the request. So:

- No Supabase edge function logs for this invocation (nothing to join on)
- No Sentry event from the edge function (never ran)
- The error surfaces in the Next.js layer but without OTel context attached

This is an example of a **cross-runtime trace gap** that would be solved if:
1. Supabase exposed the incoming `traceparent` in `edge_logs` / `function_logs` even for
   failed/aborted invocations — so you can join the error log to the trace by `trace_id`
2. The Sentry SDK's `onRequestError` hook in Next.js reliably attached OTel context across
   async gRPC boundaries (Sentry + OTel interop issue)

## What an agentic debugging session needs

To reliably diagnose a checkout failure of this kind, an agent would need:

- **Sentry MCP**: read the issue, get the stack trace and timestamp
- **Jaeger/OTLP query**: fetch all spans for the `trace_id`, confirm which service's span is
  the leaf with a 5xx status
- **Supabase MCP**: query `edge_logs` / `function_logs` by `trace_id` for the same time window
  — today this only works if the edge function was reached; if it wasn't, there's no log to
  find
- **Correlation**: join Sentry error timestamp → Jaeger trace → Supabase logs. Today the join
  requires the user to manually carry the `trace_id` between tools.

The gap the agent would hit: "I can see the Sentry error, I can see the Jaeger trace, but
Supabase has no log for this `trace_id`" — because the edge function invocation that failed
either never made it to Supabase or was aborted before the runtime logged it.

## What needs to be fixed (not doing now)

**Sentry side:**
- Ensure `@sentry/nextjs` with `skipOpenTelemetrySetup: true` correctly propagates OTel
  `trace_id` onto error events across gRPC/async boundaries. This is an SDK interop issue
  the Sentry team should own.

**Supabase side:**
- Log the incoming `traceparent` / `trace_id` on ALL edge function invocations, including
  those that fail at the gateway level (auth rejection, cold-start abort, network timeout).
  Today `function_logs` only contains logs emitted by `console.log()` inside the function —
  if the function never runs, there is no log.
- Exposing `trace_id` as a first-class queryable field on `edge_logs` and `function_logs`
  (FDBKIN-35096) would let any APM join errors to traces without per-SDK instrumentation.

## Related

- `supa-instrumentation-gap.md` — PostgREST/Postgres OTel span gap
- `pg-tracing-postgrest-otel-context.md` — deeper context on pg_tracing and query tags
- `supa-tracing-initiative/initiative.md` — P2 (SDK trace-context propagation), P6 (Edge)
- FDBKIN-35096: Propagate request trace ID into Postgres logs and Edge Functions
