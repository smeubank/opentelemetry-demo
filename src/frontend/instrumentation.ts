// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as Sentry from '@sentry/nextjs';

// Next.js server instrumentation hook. This loads the Sentry server/edge init and
// coexists with the demo's OpenTelemetry bootstrap (utils/telemetry/Instrumentation.js,
// loaded via --require), which continues to own tracing.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
