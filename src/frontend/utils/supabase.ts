// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createClient, SupabaseClient } from '@supabase/supabase-js';
// Enables W3C trace-context propagation (traceparent/tracestate/baggage) on
// supabase-js requests so the demo's trace_id reaches Supabase logs. Requires
// supabase-js >= 2.112.0. See https://supabase.com/docs/guides/observability/client-side-tracing
import '@supabase/supabase-js/tracing';

/**
 * Reads a NEXT_PUBLIC_* value from the runtime config. On the browser these are
 * injected into window.ENV by pages/_document.tsx; on the server they come from
 * the container environment (process.env). This mirrors how the demo already
 * threads OTel public config, so no build-time inlining is required.
 */
export function readPublicEnv(key: string): string {
  if (typeof window !== 'undefined' && window.ENV) {
    return (window.ENV as Record<string, string | undefined>)[key] ?? '';
  }
  // On the server, NEXT_PUBLIC_* names are inlined empty at build time, so fall back to the
  // non-prefixed runtime env var (matches how _document.tsx populates window.ENV).
  return process.env[key] ?? process.env[key.replace(/^NEXT_PUBLIC_/, '')] ?? '';
}

let client: SupabaseClient | null = null;

/**
 * Returns a lazily-created Supabase client, or null when Supabase is not
 * configured (blank URL/key). Callers must treat null as "Supabase disabled"
 * so the shop keeps working with anonymous auth and the bundled services.
 */
export function getSupabase(): SupabaseClient | null {
  const url = readPublicEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = readPublicEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) return null;
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      tracePropagation: true,
    });
  }
  return client;
}

export function isSupabaseEnabled(): boolean {
  return Boolean(readPublicEnv('NEXT_PUBLIC_SUPABASE_URL') && readPublicEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
}
