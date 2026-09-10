// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
//
// Opt-in Supabase Edge Function port of the demo's `payment` charge path. The
// checkout service calls this over HTTP (instead of gRPC to the local Node
// payment service) when PAYMENT_EDGE_FN_URL is set. It:
//   * continues the demo's OpenTelemetry trace from the incoming W3C traceparent
//     via the OTel SDK, forwarding spans to the collector (→ Jaeger + Sentry);
//   * validates the card (port of src/payment/charge.js);
//   * persists the transaction to public.transactions via supabase-js;
//   * captures errors to Sentry, linked to the OTel trace_id;
//   * returns HTTP 500 (and captures to Sentry) when the request asks it to fail
//     — this drives a real failed checkout plus Supabase's
//     log_edge_function_error_rate_high health check.
// Deploy with verify_jwt disabled so checkout/load-gen can call it with the anon
// apikey. See supademo-readme.md.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@^10";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@^2.112.0";
// Opt-in W3C trace-context propagation on supabase-js requests (see supabase.ts).
import "npm:@supabase/supabase-js@^2.112.0/tracing";

// OTel SDK — produces spans visible in Jaeger (via OTLP → collector main pipeline)
// and in Sentry (via the collector's routing connector: service.name="payment" →
// traces/sentry_payment). Opt-in via OTEL_EXPORTER_OTLP_ENDPOINT Supabase secret.
import * as otelApi from "npm:@opentelemetry/api@^1";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "npm:@opentelemetry/sdk-trace-base@^1";
import { OTLPTraceExporter } from "npm:@opentelemetry/exporter-trace-otlp-http@^0.53";
import { W3CTraceContextPropagator } from "npm:@opentelemetry/core@^1";
import { Resource } from "npm:@opentelemetry/resources@^1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Service role bypasses RLS for the insert; falls back to anon if unset.
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SENTRY_DSN = Deno.env.get("SENTRY_DSN") ?? Deno.env.get("SENTRY_DSN_PAYMENT_CHARGE");
const OTLP_ENDPOINT = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");

let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { tracePropagation: true });
}

// OTel provider — opt-in. BatchSpanProcessor.forceFlush() actually awaits the
// OTLP fetch, which is critical: edge isolates freeze immediately after the
// response is returned, so we flush synchronously before returning.
const w3c = new W3CTraceContextPropagator();
let otelProvider: BasicTracerProvider | null = null;
if (OTLP_ENDPOINT) {
  otelProvider = new BasicTracerProvider({
    resource: new Resource({ "service.name": "payment" }),
  });
  otelProvider.addSpanProcessor(
    new BatchSpanProcessor(new OTLPTraceExporter({ url: OTLP_ENDPOINT })),
  );
}

if (SENTRY_DSN) {
  const base = {
    dsn: SENTRY_DSN,
    // tracesSampleRate: 0 — Sentry does not create its own root transactions.
    // When OTel is active, trace context is set from the OTel span so errors
    // link to the correct OTel trace_id. Without OTel, continueTrace() below
    // carries the parent sampling decision via the sentry-trace header.
    tracesSampleRate: 0,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "otel-demo",
    release: Deno.env.get("SENTRY_RELEASE"),
  };
  // supabaseIntegration instruments supabase-js db/auth calls, but its argument
  // shape varies across SDK versions; if it's absent or throws, fall back to a
  // plain init so a charge is never blocked by instrumentation.
  try {
    const integrations = supabase && typeof Sentry.supabaseIntegration === "function"
      ? [Sentry.supabaseIntegration({ supabaseClient: supabase })]
      : [];
    Sentry.init({ ...base, integrations });
  } catch (_e) {
    Sentry.init(base);
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // traceparent/tracestate/baggage must be allow-listed for client-side tracing.
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, traceparent, tracestate, baggage",
};

// W3C traceparent: 00-<32 hex trace>-<16 hex span>-<2 hex flags>
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// The gateway's function_edge_logs do not parse traceparent into a trace_id
// field (unlike edge_logs), so log it explicitly to make it queryable in
// Supabase function_logs alongside Jaeger and Sentry.
function traceIdFromTraceparent(traceparent: string | null): string | undefined {
  if (!traceparent) return undefined;
  return TRACEPARENT_RE.exec(traceparent)?.[1];
}

// Convert an incoming W3C traceparent into Sentry's sentry-trace format
// (<trace>-<span>-<sampled>) for the Sentry-only fallback path (no OTel).
function sentryTraceFromTraceparent(traceparent: string | null): string | undefined {
  if (!traceparent) return undefined;
  const m = TRACEPARENT_RE.exec(traceparent);
  if (!m) return undefined;
  const sampled = (parseInt(m[3], 16) & 0x1) ? "1" : "0";
  return `${m[1]}-${m[2]}-${sampled}`;
}

const LOYALTY_LEVEL = ["platinum", "gold", "silver", "bronze"];

function luhnValid(number: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = number.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function cardType(number: string): string {
  if (/^4/.test(number)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(number)) return "mastercard";
  return "unknown";
}

interface ChargeRequest {
  amount?: { units?: number; nanos?: number; currencyCode?: string };
  creditCard?: {
    number?: string;
    cvv?: number;
    expYear?: number;
    expMonth?: number;
  };
  // "invalid_token" | "card_format" — set by checkout from the supabasePaymentError flag.
  failureMode?: string;
  // Back-compat shorthand used by the load generator to drive error volume.
  injectFailure?: boolean;
}

function resolveFailureMode(body: ChargeRequest): string {
  if (body.failureMode) return body.failureMode;
  return body.injectFailure ? "invalid_token" : "";
}

async function handleCharge(body: ChargeRequest): Promise<Response> {
  const mode = resolveFailureMode(body);

  // Blunt synthetic failure (load generator / demo "just make it fail").
  if (mode === "invalid_token") {
    throw new Error(
      "Payment request failed. Invalid token. demo.user_context.loyalty_level=gold",
    );
  }

  const card = body.creditCard ?? {};
  // The demo sends card numbers with separators (e.g. 4432-8015-6152-0454).
  // Normally we strip non-digits before validation (matching simple-card-validator).
  // The "card_format" failure mode reproduces a realistic regression: a stricter
  // parser that forgets to strip separators, so validly-formatted cards fail Luhn
  // and every checkout is wrongly rejected as invalid.
  const rawNumber = String(card.number ?? "");
  const number = mode === "card_format" ? rawNumber : rawNumber.replace(/\D/g, "");
  const type = cardType(number);
  const lastFour = number.slice(-4);

  if (!luhnValid(number)) {
    throw new Error("Credit card info is invalid.");
  }
  if (type !== "visa" && type !== "mastercard") {
    throw new Error(
      `Sorry, we cannot process ${type} credit cards. Only VISA or MasterCard is accepted.`,
    );
  }
  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentYear = now.getUTCFullYear();
  const expYear = Number(card.expYear ?? 0);
  const expMonth = Number(card.expMonth ?? 0);
  if (currentYear * 12 + currentMonth > expYear * 12 + expMonth) {
    throw new Error(
      `The credit card (ending ${lastFour}) expired on ${expMonth}/${expYear}.`,
    );
  }

  const transactionId = crypto.randomUUID();
  const loyaltyLevel = LOYALTY_LEVEL[Math.floor(Math.random() * LOYALTY_LEVEL.length)];
  const amount = body.amount ?? {};

  if (supabase) {
    const { error } = await supabase.from("transactions").insert({
      transaction_id: transactionId,
      card_type: type,
      last_four: lastFour,
      amount_units: amount.units ?? 0,
      amount_nanos: amount.nanos ?? 0,
      currency_code: amount.currencyCode ?? "USD",
      loyalty_level: loyaltyLevel,
    });
    if (error) throw new Error(`transaction persist failed: ${error.message}`);
  }

  return new Response(JSON.stringify({ transactionId }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const traceparent = req.headers.get("traceparent");
  const baggage = req.headers.get("baggage") ?? undefined;
  const traceId = traceIdFromTraceparent(traceparent) ?? null;

  const run = async (): Promise<Response> => {
    let body: ChargeRequest = {};
    try {
      body = (await req.json()) as ChargeRequest;
    } catch (_e) {
      // leave body empty; validation below will reject it
    }
    const mode = resolveFailureMode(body);
    // Structured log so the demo's trace_id + failure mode are queryable in function_logs.
    console.log(JSON.stringify({ msg: "payment-charge", trace_id: traceId, failure_mode: mode || "none" }));
    // Attach the card input so a failed charge (esp. the card_format regression) is
    // diagnosable in Sentry — an investigator can see the card was validly formatted.
    if (SENTRY_DSN) {
      Sentry.getCurrentScope().setContext("payment", {
        card_number: String(body.creditCard?.number ?? ""),
        failure_mode: mode || "none",
        trace_id: traceId,
      });
    }
    try {
      return await handleCharge(body);
    } catch (err) {
      if (SENTRY_DSN) {
        Sentry.captureException(err);
        await Sentry.flush(2000);
      }
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  };

  if (otelProvider) {
    // OTel path: continue the parent trace, create a span, link the Sentry scope
    // so captured errors carry the same trace_id, then run and flush before returning.
    const parentCtx = w3c.extract(
      otelApi.ROOT_CONTEXT,
      { traceparent: traceparent ?? "", baggage: baggage ?? "" },
      { get: (c, k) => (c as Record<string, string>)[k] || null, keys: (c) => Object.keys(c) },
    );

    const tracer = otelProvider.getTracer("payment-charge", "1.0.0");
    const span = tracer.startSpan(
      "payment-charge",
      { kind: otelApi.SpanKind.SERVER, attributes: { "faas.trigger": "http" } },
      parentCtx,
    );
    const spanCtx = span.spanContext();

    // Link the Sentry scope to this OTel span so Sentry error events carry the
    // correct trace_id and appear linked in the Sentry issue view.
    if (SENTRY_DSN) {
      const scope = Sentry.getCurrentScope();
      if (typeof scope.setPropagationContext === "function") {
        scope.setPropagationContext({
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId,
          sampled: (spanCtx.traceFlags & otelApi.TraceFlags.SAMPLED) !== 0,
        });
      }
    }

    return (async (): Promise<Response> => {
      let resp: Response = new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
      try {
        resp = await run();
        span.setStatus({
          code: resp.ok ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR,
        });
        span.setAttribute("http.status_code", resp.status);
      } catch (err) {
        span.setStatus({ code: otelApi.SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        // BatchSpanProcessor.forceFlush() awaits the OTLP fetch — must run before
        // the response is returned, since edge isolates freeze on response.
        await otelProvider!.forceFlush();
        if (SENTRY_DSN) await Sentry.flush(2000);
      }
      return resp;
    })();
  }

  // Sentry-only fallback: no OTEL_EXPORTER_OTLP_ENDPOINT configured.
  // continueTrace links the Sentry transaction to the parent OTel trace_id so
  // errors still appear under the correct trace in Sentry.
  const sentryTrace = sentryTraceFromTraceparent(traceparent);
  const spanOptions = { name: "payment-charge", op: "function.payment" };
  async function tracedSentry(): Promise<Response> {
    const resp = await Sentry.startSpan(spanOptions, run);
    if (SENTRY_DSN) await Sentry.flush(2000);
    return resp;
  }
  return sentryTrace && SENTRY_DSN
    ? Sentry.continueTrace({ sentryTrace, baggage }, tracedSentry)
    : tracedSentry();
});
