// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as Sentry from '@sentry/nextjs';

// DSN is provided at runtime via window.ENV (see pages/_document.tsx), matching how
// the demo threads its other public config. A blank DSN disables Sentry (no-op).
const dsn =
  (typeof window !== 'undefined' && window.ENV?.NEXT_PUBLIC_SENTRY_DSN) ||
  process.env.NEXT_PUBLIC_SENTRY_DSN ||
  '';

Sentry.init({
  dsn,
  environment: (typeof window !== 'undefined' && window.ENV?.NEXT_PUBLIC_SENTRY_ENVIRONMENT) || undefined,
  release: (typeof window !== 'undefined' && window.ENV?.NEXT_PUBLIC_SENTRY_RELEASE) || undefined,
  // Tracing stays on the existing OpenTelemetry web SDK (FrontendTracer.ts). Keep Sentry
  // tracing off so it does not create a second tracer or inject conflicting headers.
  tracesSampleRate: 0,
  tracePropagationTargets: [],
  enableLogs: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
