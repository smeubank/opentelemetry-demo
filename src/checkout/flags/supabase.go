// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// This file is hand-written (not produced by the OpenFeature CLI) and lives
// alongside the generated flag accessors. It follows the same shape so checkout
// can read the demo-specific supabasePaymentError flag via flags.SupabasePaymentError.
package flags

import (
	"context"

	"github.com/open-feature/go-sdk/openfeature"
)

// SupabasePaymentError returns the value of the "supabasePaymentError" feature flag.
// It selects the payment-charge edge function's failure mode: "" (off),
// "invalid_token" (blunt synthetic failure) or "card_format" (realistic card-parser
// regression). A failure produces a failed checkout plus a Sentry issue and a
// Supabase edge-function health check.
//
// The flag is a type of string and defaults to "".
var SupabasePaymentError = struct {
	Value            evaluationValue[string]
	ValueWithDetails evaluationDetails[string]
}{
	Value: func(ctx context.Context, evalCtx openfeature.EvaluationContext) string {
		return client.String(ctx, "supabasePaymentError", "", evalCtx)
	},
	ValueWithDetails: func(ctx context.Context, evalCtx openfeature.EvaluationContext) (openfeature.GenericEvaluationDetails[string], error) {
		return client.StringValueDetails(ctx, "supabasePaymentError", "", evalCtx)
	},
}
