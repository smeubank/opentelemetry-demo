// Deliberately-failing Edge Function used to drive Supabase's
// `log_edge_function_error_rate_high` health check from the demo's load generator.
// Returns HTTP 500 on every request. Deploy with verify_jwt disabled so the load
// generator can hit it with only the anon apikey. See supademo-readme.md.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => {
  return new Response(
    JSON.stringify({ error: "synthetic failure for health-check testing" }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
});
