// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const Sentry = require('@sentry/node')

// DSN, environment and release are read from SENTRY_DSN, SENTRY_ENVIRONMENT
// and SENTRY_RELEASE. An empty/absent SENTRY_DSN makes init a no-op.
// tracesSampleRate is 0 and skipOpenTelemetrySetup is true so that the existing
// @opentelemetry/auto-instrumentations-node setup remains the sole tracer.
Sentry.init({
  tracesSampleRate: 0,
  skipOpenTelemetrySetup: true,
})
