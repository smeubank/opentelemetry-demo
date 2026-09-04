// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as Sentry from '@sentry/nextjs';

// A blank DSN disables Sentry (no-op), keeping the default demo unchanged.
Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '',
  environment: process.env.SENTRY_ENVIRONMENT || undefined,
  release: process.env.SENTRY_RELEASE || undefined,
  // Tracing stays on the existing OpenTelemetry Node SDK (utils/telemetry/Instrumentation.js).
  // Keep Sentry tracing off and do not let it register its own OpenTelemetry setup, so the
  // two do not conflict and Jaeger remains the single source of traces.
  tracesSampleRate: 0,
  skipOpenTelemetrySetup: true,
  includeLocalVariables: true,
  enableLogs: true,
});
