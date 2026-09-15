// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// This file is hand-written (not produced by the OpenFeature CLI) and lives
// alongside the generated flag accessors. It follows the same shape so
// product-catalog can read the demo-specific supabaseDatabaseBackend flag.
package flags

import (
	"context"

	"github.com/open-feature/go-sdk/openfeature"
)

// SupabaseDatabaseBackend returns the value of the "supabaseDatabaseBackend"
// feature flag, which selects the Postgres serving product reads: "supabase"
// (the configured primary backend) or "astronomy_pg" (the astronomy-db deployed
// with pg_tracing). It only takes effect when ASTRONOMY_DB_CONNECTION_STRING is
// configured; otherwise the service always uses its single configured backend.
// See supa-db-backend.md.
//
// The flag is a type of string and defaults to "supabase".
var SupabaseDatabaseBackend = struct {
	Value            evaluationValue[string]
	ValueWithDetails evaluationDetails[string]
}{
	Value: func(ctx context.Context, evalCtx openfeature.EvaluationContext) string {
		return client.String(ctx, "supabaseDatabaseBackend", "supabase", evalCtx)
	},
	ValueWithDetails: func(ctx context.Context, evalCtx openfeature.EvaluationContext) (openfeature.GenericEvaluationDetails[string], error) {
		return client.StringValueDetails(ctx, "supabaseDatabaseBackend", "supabase", evalCtx)
	},
}
