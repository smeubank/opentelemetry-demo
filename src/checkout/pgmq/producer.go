// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Package pgmq is the opt-in Supabase Queues (pgmq) producer for the order flow,
// the alternative to the Kafka producer in the sibling kafka package. It sends each
// OrderResult onto Postgres-native queues via pgmq.send over a session-pooler
// connection, so checkout's DB auto-instrumentation emits a db span for the SQL.
package pgmq

import (
	"context"
	"database/sql"
	"fmt"
	"os"

	"github.com/XSAM/otelsql"
	_ "github.com/lib/pq"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// The two order fan-out queues, one per consumer, reproducing Kafka's independent
// consumer groups (see supabase/migrations/0004_pgmq_queues.sql).
const (
	QueueAccounting = "orders_accounting"
	QueueFraud      = "orders_fraud"
)

// Queues is the set of queues each OrderResult is sent to.
var Queues = []string{QueueAccounting, QueueFraud}

// Producer wraps an otel-instrumented Postgres connection used to send OrderResult
// envelopes via pgmq.send.
type Producer struct {
	db *sql.DB
}

// CreateProducer opens a pgmq producer from CHECKOUT_PGMQ_DB_CONNECTION_STRING.
// An empty DSN returns (nil, nil) so checkout stays on the Kafka path.
func CreateProducer() (*Producer, error) {
	connStr := os.Getenv("CHECKOUT_PGMQ_DB_CONNECTION_STRING")
	if connStr == "" {
		return nil, nil
	}

	dbAttrs := otelsql.WithAttributes(
		append(otelsql.AttributesFromDSN(connStr), semconv.DBSystemPostgreSQL)...,
	)

	db, err := otelsql.Open("postgres", connStr, dbAttrs, otelsql.WithSQLCommenter(true))
	if err != nil {
		return nil, err
	}

	if err := db.PingContext(context.Background()); err != nil {
		return nil, err
	}

	return &Producer{db: db}, nil
}

// Send writes a JSONB envelope onto the named queue via pgmq.send. The SQL runs on
// the supplied context so its db span nests under the caller's publish span.
func (p *Producer) Send(ctx context.Context, queue string, envelope []byte) error {
	if _, err := p.db.ExecContext(ctx, "SELECT pgmq.send($1, $2::jsonb)", queue, string(envelope)); err != nil {
		return fmt.Errorf("pgmq.send to %s: %w", queue, err)
	}
	return nil
}
