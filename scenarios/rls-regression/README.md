# Scenario: rls-regression

The sharpest **performance combo** in the demo: an authenticated feed read whose
latency steps up because the **database** changed — a migration adds a 4th permissive
SELECT policy whose `USING` clause calls `auth.uid()` **bare** inside a correlated
subquery, so Postgres re-evaluates it for **every candidate row**. No client/query
change accompanies it.

This is the case that is only legible from both sides at once: Sentry sees a `db`
span on `shop.product_reviews` get slower with the same query text; Supabase's
performance advisors (`auth_rls_initplan`, `multiple_permissive_policies`) name the
policy. The right attribution is "the schema changed," and the fix lives in the DB,
not the client.

It also doubles as the realistic fixture source for the Track B eval
`o11y-investigate-attribution-rls-regression`.

## Two knobs
- **flagd** drives application behavior (authenticated feed reads via the load
  generator / a logged-in browser session).
- **This fixture** is the *database* knob: apply `00_baseline.sql` for the "before"
  state, then apply `01_regression.sql` at the change point for the "after" state.
  `99_teardown.sql` resets.

## The query under test
An authenticated client reads a product's recent reviews:

```sql
-- run as the `authenticated` role
SELECT id, product_id, author_id, rating, body, created_at
FROM shop.product_reviews
WHERE product_id = $1
ORDER BY created_at DESC
LIMIT 20;
```

- After `00_baseline.sql`: 3 permissive policies, each wrapping `auth.uid()` in
  `(SELECT auth.uid())` so it is hoisted into an initplan (once per query). Fast.
- After `01_regression.sql`: a 4th permissive policy calls `auth.uid()` bare inside a
  correlated `EXISTS`, re-evaluated per row. Latency steps up; the two advisors fire.

## Compress time, don't backdate
At the change point, emit a **real Sentry release marker** and write a **real**
`supabase_migrations.schema_migrations` row (the migration timestamp is the only
timestamped record of when the policy appeared — Postgres catalogs carry none). The
reasoning under test ("align the latency step to a boundary") is scale-invariant, so
a short real timeline works.

## Apply (Supabase CLI / MCP / psql)
```bash
# baseline ("before")
psql "$SUPABASE_DB_URL_DIRECT" -f scenarios/rls-regression/00_baseline.sql

# ...run baseline load for a few minutes...

# the change ("after") — this is the boundary the agent must find
psql "$SUPABASE_DB_URL_DIRECT" -f scenarios/rls-regression/01_regression.sql

# reset between runs
psql "$SUPABASE_DB_URL_DIRECT" -f scenarios/rls-regression/99_teardown.sql
```

Keep the agent blind: none of these files, nor flagd state, should be reachable from
any tool the investigating agent can call.
