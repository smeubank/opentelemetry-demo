// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as Sentry from '@sentry/nextjs';

// A blank DSN disables Sentry (no-op). The demo has no edge routes today; this exists
// for completeness so edge-runtime code would be covered if added.
Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '',
  environment: process.env.SENTRY_ENVIRONMENT || undefined,
  release: process.env.SENTRY_RELEASE || undefined,
  tracesSampleRate: 0,
  enableLogs: true,
});
