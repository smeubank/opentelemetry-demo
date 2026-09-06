# Supabase + Sentry demo — build status

Working tracker for the marketing-event demo (Supabase health checks + observability
agents on auto-pilot) and its eval counterpart. Read this top-down; newest status at
the top of each phase. Full plan lives in the Claude plan file; this is the running log.

**Goal:** an interactive recorded video — flip a flagd flag → it triggers errors →
run the observability agent → the agent picks up the errors and reports. Sentry
hookup (error also lands in Sentry) is the side quest that makes it a "two signal
sources" story.

## Status legend
⬜ not started · 🟡 in progress · ✅ done · ⚠️ blocked / needs decision

---

## Track C — live scenario harness (this repo)

### Phase 0 — trace propagation (prerequisite) ✅ Jaeger↔Supabase verified (Sentry leg = Phase 1)
Everything downstream needs `trace_id` in Supabase logs. Correct API is
`tracePropagation: true` + `import '@supabase/supabase-js/tracing'` (supabase-js
≥ 2.112.0) — **not** the `propagateTraceparent`/`sendOperationData` names from the
HANDOFF (stale). Installed supabase-js is **2.115.0** ✅ (supports it).

- ✅ supabase-js: `tracePropagation: true` + tracing import in
  `src/frontend/utils/supabase.ts`; declared range bumped to `^2.112.0`
  (package.json + package-lock.json root entry).
- ✅ load-generator: **no change needed** — `RequestsInstrumentor().instrument()`
  (locustfile.py:71) already injects W3C `traceparent` on the `requests`-based
  Supabase calls, and `SupabaseServiceErrorUser` wraps each hit in an active span.
- ✅ **Runtime verify (2026-09-06, live stack):** `Jaeger ↔ Supabase logs` correlation
  CONFIRMED via the load-generator path. Flipped `supabaseServiceErrors=data_api` → load-gen
  hit `/rest/v1/rpc/health_check_boom` (500s) with W3C `traceparent` (injected by
  `RequestsInstrumentor`). Supabase `edge_logs` captured it and **parses it into queryable
  top-level fields**: `log_attributes['trace_id']`, `['span_id']`, and raw
  `['request.headers.traceparent']` (flat dot-notation keys — nested map access errors).
  Took 3 `trace_id`s straight from Supabase logs; all 3 exist verbatim in Jaeger on
  `load-generator`, same URL, same 500. Query: `select log_attributes['trace_id'],
  log_attributes['request.headers.traceparent'] from logs where source='edge_logs'`.
- ✅ **Sentry leg — resolved in Phase 1.** The original blocker (the old `health-check-error` fn
  never continued the incoming `traceparent`, so its Sentry issue got a fresh trace_id) is fixed by
  the new `payment-charge` fn, which converts `traceparent`→`sentry-trace` and calls
  `Sentry.continueTrace` (tracing stays off; propagation only). Verified: one trace_id spans
  Jaeger + Sentry + Supabase logs — see Phase 1.
- ⬜ (browser leg, optional) confirm supabase-js `tracePropagation` from a real browser
  session also lands in Supabase logs (auth calls on `/login`) — same mechanism, untested live.

### Phase 1 — payment-charge edge function (the video) ✅ deployed + verified end-to-end (recording pending)
**Pivot (2026-09-06):** dropped the synthetic `health_check_boom` RPC + `health-check-error`
fn. The real demo surface is now an opt-in **`payment-charge` Supabase Edge Function** — a Deno
port of `src/payment/charge.js` that checkout calls over HTTP when `PAYMENT_EDGE_FN_URL` is set.
Full plan: `~/.claude/plans/polymorphic-strolling-walrus.md`.
- ✅ `supabase/functions/payment-charge/index.ts`: Sentry Deno SDK (`tracesSampleRate:0`),
  **continues incoming W3C `traceparent`** (converts→`sentry-trace`, `Sentry.continueTrace`) so the
  Sentry issue shares the OTel trace_id (fixes the Phase-0 gap); ports card validation; persists to
  `public.transactions` via supabase-js; `injectFailure`→500. Defensive init (bad supabaseIntegration
  can't block a charge).
- ✅ `src/checkout/main.go`: env-gated `chargeCardViaEdge` (otelhttp client → traceparent);
  **compiles clean** (`make build service=checkout` exit 0). New flag accessor
  `src/checkout/flags/supabase.go` (`SupabasePaymentError`).
- ✅ Flag `supabasePaymentError` (3-way string: off/invalid_token/card_format) in demo.flagd.json;
  load-gen `edge_function` variant repointed to `/functions/v1/payment-charge` (data_api variant +
  health_check_boom removed).
- ✅ Migration `0003_transactions.sql`; compose/.env/.env.local.example gated on `PAYMENT_EDGE_FN_URL`;
  supademo-readme.md Trigger 2 rewritten.
- ✅ **Deployed + verified live (2026-09-06):** applied `0003` (MCP), `supabase functions deploy
  payment-charge --no-verify-jwt` (CLI), set `SENTRY_DSN`+`SENTRY_ENVIRONMENT` secrets (CLI;
  `SUPABASE_URL`/`SERVICE_ROLE_KEY` are auto-injected), `make redeploy service=checkout`.
  - **Happy path:** real shop order → HTTP 200 orderId; row in `public.transactions`; Jaeger trace
    `checkout → POST payment-charge` (200). 3 checkout trace_ids matched **verbatim** in Supabase
    `function_logs`. (Jaeger ↔ Supabase logs confirmed for the real checkout path.)
  - **Failed checkout:** `supabasePaymentError` → HTTP 422 `PAYMENT_FAILED` (frontend structured
    error); Jaeger `checkout → payment-charge` span status 500/error; failed trace_ids matched
    verbatim in `function_logs`.
  - **card_format failure mode added (2026-09-06):** `supabasePaymentError` is now a 3-way string
    flag — `off` / `invalid_token` (blunt) / `card_format` (realistic regression: a too-strict
    parser rejects validly-formatted dashed cards as "Credit card info is invalid"). Checkout
    passes the mode; the failing card is attached to the Sentry event. Verified end-to-end: order →
    422; Jaeger trace `fd936cd9…` full-stack with edge span 500; `function_logs` shows
    `failure_mode: card_format` + matching trace_id. deno check + checkout build clean; both redeployed.
  - **Two bugs found+fixed during verify:** (1) `function_edge_logs` does NOT parse traceparent→
    trace_id (unlike gateway `edge_logs`) → added a `console.log({trace_id})` so it's queryable in
    `function_logs`. (2) demo card numbers have dashes (`4432-8015-…`) → edge fn Luhn rejected every
    real checkout as invalid → strip non-digits before validation. Both redeployed.
  - ✅ **Sentry leg VERIFIED (2026-09-06):** with `SENTRY_PERSONAL_TOKEN` (user token, scopes
    event:read/project:read/team:read — NOTE the Discover `…/events/` endpoint needs `org:read`
    which it lacks, but the org `…/issues/?query=trace:<id>` endpoint works). Query
    `trace:fd936cd9ecde9857e5d811e7547cf638` returned issue `OTEL-SHOP-NEXTJS-4`
    "Error: Credit card info is invalid.", culprit `handleCharge(...payment-charge/index.ts)`.
    Event `4d0fc8da…`: **`contexts.trace.trace_id` == the Jaeger + function_logs trace_id**,
    `payment` context `failure_mode=card_format`, runtime `deno supabase-edge-runtime`. So ONE
    trace_id spans Jaeger + Sentry + Supabase logs. (Sentry scrubs `card_number`→`[Filtered]` by
    default PII rules; relax the credit-card rule if the demo wants it visible.)
- ✅ **Health check FIRED (2026-09-06):** held `supabaseServiceErrors=edge_function` → the load-gen
  drove the volume and `POST /v2/projects/{ref}/advisors/run` returned `log_edge_function_error_rate_high`
  = ERROR: "Failing: /functions/v1/payment-charge (90.12% of 81 requests failing)" across two 5-min
  windows. So the full loop is live: failed checkout → Sentry issue + Supabase health check, one trace_id.
  (Note: edge-fn request logs are info-severity with status as a field, so a dashboard error-filter
  looks empty; the health category is API-only, not in the dashboard UI yet.)
- ⬜ Record the run (flag flip, failed checkout, Sentry issue, health-check response, agent transcript)

### Phase 2 — fix connection exhaustion ⬜
- ⬜ Diagnose suspected bug (cert/TLS failure masquerading as `too many connections`)

### Phase 3 — RLS performance combo 🟡 (fixture drafted; live run pending)
- ✅ Fixture SQL in `scenarios/rls-regression/`: `00_baseline.sql` (3 cheap permissive
  policies, all `(SELECT auth.uid())`-hoisted) → `01_regression.sql` (4th permissive
  policy w/ bare `auth.uid()` in a correlated subquery → per-row re-eval; writes a real
  `schema_migrations` row) → `99_teardown.sql`. README documents the two knobs + query.
- ⬜ Fixture runner script to apply baseline/change at the boundary (part of Phase 4)
- ⬜ Live run: authenticated reads → `db` spans in Sentry + advisors fire

### Phase 4 — recording harness ⬜
- ⬜ Timestamped per-scenario JSON bundles; agent kept blind to flag/scenario state
- ✅ **Agent test prompt** authored: `supa-agent-prompt.md` — generalist read-only Supabase
  monitoring agent + the Sentry addendum (combine signals, Seer for RCA on perf/security),
  with a "what you should see" section grounded in the live payment-charge scenario. Realizes
  the HANDOFF Track A addendum as a paste-and-test prompt (read-only; escalation/writes omitted).

---

## Track B — attribution evals (supabase/evals PR #256, remote) 🟡 drafts staged
Drafted under `evals-staging/` (gitignored — **not** part of this demo PR). Ready to
paste into a `supabase/evals` checkout. Each = PROMPT.md + EVAL.ts (regex checks + LLM
judge scoring accuracy **and** restraint) + remote/project.sql (faked pg_stat_statements
+ `sentry_releases`/`sentry_transaction_stats` shadow tables + real schema_migrations).
Verified the harness provides `auth.uid()` (o11y-0006 uses it) and enums are valid
(`suite: regression`, `interface: mcp`).

- ✅ `client-regression` (authored first per HANDOFF; distractor = standing auth_rls_initplan)
- ✅ `rls-regression` (distractor = tempting "add pagination"; step aligns to migration)
- ✅ `organic-growth` (restraint axis: ramp not step; correct answer "not a regression")
- ✅ `latent-schema-defect` (release *exposed* an unindexed FK; fix = index, not revert)
- ✅ Decision recorded: Sentry surface = **shadow tables now**; mock MCP server = follow-up
- ⬜ Run `client-regression` in a real evals checkout; report scorer brittleness (HANDOFF's first task)

---

## Log
- 2026-09-06 — Plan approved. Created this tracker. Confirmed supabase-js 2.115.0
  installed (supports `tracePropagation`); corrected the propagation API vs HANDOFF.
- 2026-09-06 — Phase 0 code: wired `tracePropagation: true` + tracing import in
  `supabase.ts`; bumped declared range to `^2.112.0`. Found the load generator
  already propagates `traceparent` via `RequestsInstrumentor` — no httpx switch
  needed. Phase 1 code: added opt-in Sentry Deno SDK to `health-check-error` and
  documented the `SENTRY_DSN` secret. Remaining Phase 0/1 items are runtime
  verifications that need the live stack + Supabase/Sentry creds.
- 2026-09-06 — **Phase 0 runtime verify DONE (Jaeger↔Supabase).** Live stack up (28
  containers). Confirmed load-gen's `traceparent` reaches Supabase `edge_logs` AND is parsed
  into a queryable `trace_id` field; 3 IDs cross-matched Supabase→Jaeger exactly. Found the
  Sentry leg needs the edge fn to continue the incoming `traceparent` (currently gets a fresh
  trace_id). Gate lifted for Phase 1. Jaeger API path (local): `http://localhost:8080/jaeger/ui/api`.
- 2026-09-06 — Phase 3 fixture drafted (`scenarios/rls-regression/`). Track B: all
  four attribution evals drafted under `evals-staging/` (gitignored); grounded in the
  demo's 10 real product IDs; verified `auth.uid()` and the metadata enums against the
  existing PR. Next: live verification (Phase 0 gate) and running `client-regression`
  in an evals checkout.
- 2026-09-06 — **Phase 1 pivot shipped + verified.** Replaced synthetic scaffolding with the
  opt-in `payment-charge` edge function; deployed it + `0003` migration + `SENTRY_DSN` secret;
  redeployed checkout/load-gen. Verified all three signals share one trace_id (Jaeger + Sentry
  via `continueTrace` + Supabase `function_logs`), and `log_edge_function_error_rate_high` fired
  at 90.12%. Added the `card_format` realistic-regression failure mode (Steven's idea). Fixed the
  flagd-ui clobber (must `make restart service=flagd-ui` after adding a flag while the stack is up).
  Authored `supa-agent-prompt.md` (read-only agent test prompt). Docs (supa-readme/supademo-readme)
  refreshed. Remaining on Track C: record the run (Steven), Phase 2/3 live runs, Phase 4 harness.
