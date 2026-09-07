// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

//go:generate go install google.golang.org/protobuf/cmd/protoc-gen-go
//go:generate go install google.golang.org/grpc/cmd/protoc-gen-go-grpc
//go:generate protoc --go_out=./ --go-grpc_out=./ --proto_path=../../pb ../../pb/demo.proto
//go:generate go install github.com/open-feature/cli/cmd/openfeature@v0.4.0
//go:generate openfeature generate -o flags --package-name flags go

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	_ "github.com/lib/pq"
	supa "github.com/supabase-community/supabase-go"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc/filters"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/contrib/otelconf"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.38.0"
	"go.opentelemetry.io/otel/trace"

	otelhooks "github.com/open-feature/go-sdk-contrib/hooks/open-telemetry/pkg"
	flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
	"github.com/open-feature/go-sdk/openfeature"
	pb "github.com/opentelemetry/opentelemetry-demo/src/product-catalog/genproto/oteldemo"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	"github.com/XSAM/otelsql"
	flags "github.com/opentelemetry/opentelemetry-demo/src/product-catalog/flags"
)

type productCatalog struct {
	pb.UnimplementedProductCatalogServiceServer
}

var (
	logger *slog.Logger
	db     *sql.DB
	reg    metric.Registration
)

func init() {
	logger = otelslog.NewLogger("product-catalog")
}

// errProductNotFound is returned by a store's Get when the product id has no row,
// so the handler can distinguish "not found" from a real backend failure.
var errProductNotFound = errors.New("product not found")

// productStore abstracts the two read backends: the Supabase PostgREST data API
// (restStore, used when SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY are set) and the
// original direct-Postgres path (sqlStore, the fallback). The data API avoids the
// transaction pooler's prepared-statement limitation that breaks lib/pq under load.
type productStore interface {
	List(ctx context.Context) ([]*pb.Product, error)
	Search(ctx context.Context, query string) ([]*pb.Product, error)
	Get(ctx context.Context, id string) (*pb.Product, error)
}

var store productStore

const productColumns = "id,name,description,picture,price_currency_code,price_units,price_nanos,categories"

// sqlStore is the original lib/pq direct-Postgres backend (fallback, unchanged).
type sqlStore struct{}

func (sqlStore) List(ctx context.Context) ([]*pb.Product, error) { return loadProductsFromDB(ctx) }
func (sqlStore) Search(ctx context.Context, q string) ([]*pb.Product, error) {
	return searchProductsFromDB(ctx, q)
}
func (sqlStore) Get(ctx context.Context, id string) (*pb.Product, error) {
	return getProductFromDB(ctx, id)
}

// productRow maps a catalog.products row from the PostgREST data API.
type productRow struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Picture      string `json:"picture"`
	CurrencyCode string `json:"price_currency_code"`
	Units        int64  `json:"price_units"`
	Nanos        int32  `json:"price_nanos"`
	Categories   string `json:"categories"`
}

func mapProductRows(rows []productRow) []*pb.Product {
	products := make([]*pb.Product, 0, len(rows))
	for _, r := range rows {
		products = append(products, parseProductRow(r.ID, r.Name, r.Description, r.Picture, r.CurrencyCode, r.Categories, r.Units, r.Nanos))
	}
	return products
}

// restStore reads products through the Supabase PostgREST data API via supabase-go.
// PostgREST is stateless HTTP with a server-managed pool, so there are no prepared
// statements and no pooler exhaustion under concurrency.
type restStore struct {
	client *supa.Client
}

func (s restStore) List(ctx context.Context) ([]*pb.Product, error) {
	var rows []productRow
	if _, err := s.client.From("products").Select(productColumns, "", false).ExecuteTo(&rows); err != nil {
		return nil, err
	}
	return mapProductRows(rows), nil
}

func (s restStore) Search(ctx context.Context, q string) ([]*pb.Product, error) {
	pattern := "*" + q + "*"
	var rows []productRow
	filter := fmt.Sprintf("name.ilike.%s,description.ilike.%s", pattern, pattern)
	if _, err := s.client.From("products").Select(productColumns, "", false).Or(filter, "").ExecuteTo(&rows); err != nil {
		return nil, err
	}
	return mapProductRows(rows), nil
}

func (s restStore) Get(ctx context.Context, id string) (*pb.Product, error) {
	var rows []productRow
	if _, err := s.client.From("products").Select(productColumns, "", false).Eq("id", id).ExecuteTo(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errProductNotFound
	}
	return mapProductRows(rows)[0], nil
}

// initStore selects the read backend: the Supabase data API when the Supabase URL
// and publishable key are set, otherwise the direct-Postgres fallback.
func initStore() error {
	url := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
	key := strings.TrimSpace(os.Getenv("SUPABASE_PUBLISHABLE_KEY"))
	if url != "" && key != "" {
		// catalog.products lives in the catalog schema, exposed to the data API.
		client, err := supa.NewClient(url, key, &supa.ClientOptions{Schema: "catalog"})
		if err != nil {
			return fmt.Errorf("failed to create supabase client: %w", err)
		}
		store = restStore{client: client}
		logger.Info("Product catalog reads via the Supabase data API (PostgREST)")
		return nil
	}
	if err := initDatabase(); err != nil {
		return err
	}
	store = sqlStore{}
	logger.Info("Product catalog reads via direct Postgres (lib/pq)")
	return nil
}

func initDatabase() error {
	connStr := os.Getenv("DB_CONNECTION_STRING")
	if connStr == "" {
		return fmt.Errorf("DB_CONNECTION_STRING environment variable not set")
	}

	dbAttrs := otelsql.WithAttributes(
		append(otelsql.AttributesFromDSN(connStr), semconv.DBSystemNamePostgreSQL)...,
	)

	var err error
	db, err = otelsql.Open("postgres", connStr,
		dbAttrs,
		otelsql.WithSQLCommenter(true),
		otelsql.WithSpanOptions(otelsql.SpanOptions{
			OmitConnResetSession: true,
			OmitRows:             true,
		}))
	if err != nil {
		return fmt.Errorf("failed to open database connection: %w", err)
	}

	reg, err = otelsql.RegisterDBStatsMetrics(db, dbAttrs)
	if err != nil {
		return fmt.Errorf("failed to register database metrics: %w", err)
	}

	// Test the connection
	if err := db.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	logger.Info("Database connection established")
	return nil
}

func main() {
	ctx := context.Background()

	// Initialize Sentry for error reporting. DSN, environment and release are
	// read from the SENTRY_* environment variables. Tracing is intentionally
	// disabled because OpenTelemetry owns tracing in this service. An empty DSN
	// disables Sentry, so a missing DSN is not fatal.
	if err := sentry.Init(sentry.ClientOptions{EnableTracing: false}); err != nil {
		logger.Error(fmt.Sprintf("sentry.Init failed: %v", err))
	} else {
		defer sentry.Flush(2 * time.Second)
	}

	// Initialize OpenTelemetry SDK with otelconf
	sdk, err := otelconf.NewSDK(otelconf.WithContext(ctx))
	if err != nil {
		logger.Error(fmt.Sprintf("Failed to initialize OpenTelemetry SDK: %v", err))
		os.Exit(1)
	}
	defer func() {
		if err := sdk.Shutdown(ctx); err != nil {
			logger.Error(fmt.Sprintf("Error shutting down OpenTelemetry SDK: %v", err))
		}
		logger.Info("Shutdown OpenTelemetry SDK")
	}()

	// Set global providers and propagator
	otel.SetTracerProvider(sdk.TracerProvider())
	otel.SetMeterProvider(sdk.MeterProvider())
	global.SetLoggerProvider(sdk.LoggerProvider())
	otel.SetTextMapPropagator(sdk.Propagator())

	// Initialize the product read backend (Supabase data API or direct Postgres)
	if err := initStore(); err != nil {
		logger.Error(fmt.Sprintf("Error initializing database: %v", err))
		sentry.CaptureException(err)
		sentry.Flush(2 * time.Second)
		os.Exit(1)
	}
	defer func() {
		if db != nil {
			if err := db.Close(); err != nil {
				logger.Error(fmt.Sprintf("Error closing database connection: %v", err))
			} else {
				logger.Info("Database connection closed")
			}
		}
		if reg != nil {
			if err := reg.Unregister(); err != nil {
				logger.Error(fmt.Sprintf("Error unregistering database metrics: %v", err))
			} else {
				logger.Info("Database metrics unregistered")
			}
		}
	}()

	openfeature.AddHooks(otelhooks.NewTracesHook())
	provider, err := flagd.NewProvider()
	if err != nil {
		logger.Error("Error creating flagd provider", slog.Any("error", err))
	}

	err = openfeature.SetProvider(provider)
	if err != nil {
		logger.Error("Failed to set flagd as the provider", slog.Any("error", err))
	}
	defer openfeature.Shutdown()

	err = runtime.Start(runtime.WithMinimumReadMemStatsInterval(time.Second))
	if err != nil {
		logger.Error(err.Error())
	}

	svc := &productCatalog{}
	var port string
	mustMapEnv(&port, "PRODUCT_CATALOG_PORT")

	logger.Info(fmt.Sprintf("Product Catalog gRPC server started on port: %s", port))

	ln, err := net.Listen("tcp", fmt.Sprintf(":%s", port))
	if err != nil {
		logger.Error(fmt.Sprintf("TCP Listen: %v", err))
	}

	srv := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler(
			otelgrpc.WithFilter(filters.Not(filters.HealthCheck())),
		)),
	)

	reflection.Register(srv)

	pb.RegisterProductCatalogServiceServer(srv, svc)

	healthcheck := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthcheck)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGKILL)
	defer cancel()

	go func() {
		defer sentry.CurrentHub().Recover(nil)
		if err := srv.Serve(ln); err != nil {
			logger.Error(fmt.Sprintf("Failed to serve gRPC server, err: %v", err))
		}
	}()

	<-ctx.Done()

	srv.GracefulStop()
	logger.Info("Product Catalog gRPC server stopped")
}

func loadProductsFromDB(ctx context.Context) ([]*pb.Product, error) {
	if db == nil {
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Query all products with categories
	rows, err := db.QueryContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		ORDER BY p.id
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query products: %w", err)
	}
	defer rows.Close()

	products, err := getProductsFromRows(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("failed to get products from rows: %w", err)
	}

	return products, nil
}

func searchProductsFromDB(ctx context.Context, query string) ([]*pb.Product, error) {
	if db == nil {
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Query products matching search query in name or description
	searchPattern := "%" + strings.ToLower(query) + "%"
	rows, err := db.QueryContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		WHERE LOWER(p.name) LIKE $1 OR LOWER(p.description) LIKE $1
		ORDER BY p.id
	`, searchPattern)
	if err != nil {
		return nil, fmt.Errorf("failed to query products: %w", err)
	}
	defer rows.Close()

	products, err := getProductsFromRows(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("failed to get products from rows: %w", err)
	}

	return products, nil
}

func getProductFromDB(ctx context.Context, productID string) (*pb.Product, error) {
	if db == nil {
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Query single product by ID
	row := db.QueryRowContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		WHERE p.id = $1
	`, productID)

	var id, name, description, picture, currencyCode, categoriesStr string
	var units int64
	var nanos int32

	if err := row.Scan(&id, &name, &description, &picture, &currencyCode, &units, &nanos, &categoriesStr); err != nil {
		if err == sql.ErrNoRows {
			return nil, errProductNotFound
		}
		return nil, fmt.Errorf("failed to scan product row: %w", err)
	}

	return parseProductRow(id, name, description, picture, currencyCode, categoriesStr, units, nanos), nil
}

func getProductsFromRows(ctx context.Context, rows *sql.Rows) ([]*pb.Product, error) {
	var products []*pb.Product

	for rows.Next() {
		var id, name, description, picture, currencyCode, categoriesStr string
		var units int64
		var nanos int32

		if err := rows.Scan(&id, &name, &description, &picture, &currencyCode, &units, &nanos, &categoriesStr); err != nil {
			return nil, fmt.Errorf("failed to scan product row: %w", err)
		}

		products = append(products, parseProductRow(id, name, description, picture, currencyCode, categoriesStr, units, nanos))
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating product rows: %w", err)
	}

	logger.LogAttrs(
		ctx,
		slog.LevelInfo,
		fmt.Sprintf("Found %d products from database", len(products)),
		slog.Int("products", len(products)),
	)

	return products, nil
}

func parseProductRow(id, name, description, picture, currencyCode, categoriesStr string, units int64, nanos int32) *pb.Product {
	// Parse comma-delimited categories string into slice
	var categories []string
	if categoriesStr != "" {
		categories = strings.Split(categoriesStr, ",")
		// Trim whitespace from each category
		for i, cat := range categories {
			categories[i] = strings.TrimSpace(cat)
		}
	}

	return &pb.Product{
		Id:          id,
		Name:        name,
		Description: description,
		Picture:     picture,
		PriceUsd: &pb.Money{
			CurrencyCode: currencyCode,
			Units:        units,
			Nanos:        nanos,
		},
		Categories: categories,
	}
}

func mustMapEnv(target *string, key string) {
	value, present := os.LookupEnv(key)
	if !present {
		logger.Error(fmt.Sprintf("Environment Variable Not Set: %q", key))
	}
	*target = value
}

func (p *productCatalog) Check(ctx context.Context, req *healthpb.HealthCheckRequest) (*healthpb.HealthCheckResponse, error) {
	return &healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_SERVING}, nil
}

func (p *productCatalog) Watch(req *healthpb.HealthCheckRequest, ws healthpb.Health_WatchServer) error {
	return status.Errorf(codes.Unimplemented, "health check via Watch not implemented")
}

func (p *productCatalog) ListProducts(ctx context.Context, req *pb.Empty) (*pb.ListProductsResponse, error) {
	span := trace.SpanFromContext(ctx)

	products, err := store.List(ctx)
	if err != nil {
		span.SetStatus(otelcodes.Error, err.Error())
		return nil, status.Errorf(codes.Internal, "failed to load products: %v", err)
	}

	span.SetAttributes(
		attribute.Int("demo.product.count", len(products)),
	)
	return &pb.ListProductsResponse{Products: products}, nil
}

func (p *productCatalog) GetProduct(ctx context.Context, req *pb.GetProductRequest) (*pb.Product, error) {
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("demo.product.id", req.Id),
	)

	// GetProduct will fail on a specific product when feature flag is enabled
	if p.checkProductFailure(ctx, req.Id) {
		msg := "Error: Product Catalog Fail Feature Flag Enabled"
		span.SetStatus(otelcodes.Error, msg)
		span.AddEvent(msg)
		return nil, status.Error(codes.Internal, msg)
	}

	found, err := store.Get(ctx, req.Id)
	if err != nil {
		if errors.Is(err, errProductNotFound) {
			msg := fmt.Sprintf("Product Not Found: %s", req.Id)
			span.SetStatus(otelcodes.Error, msg)
			span.AddEvent(msg)
			return nil, status.Error(codes.NotFound, msg)
		}
		// A real backend error must not masquerade as NOT_FOUND.
		span.SetStatus(otelcodes.Error, err.Error())
		return nil, status.Errorf(codes.Internal, "failed to get product %s: %v", req.Id, err)
	}

	span.AddEvent("Product Found")
	span.SetAttributes(
		attribute.String("demo.product.id", req.Id),
		attribute.String("demo.product.name", found.Name),
	)

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Product Found",
		slog.String("demo.product.name", found.Name),
		slog.String("demo.product.id", req.Id),
	)

	return found, nil
}

func (p *productCatalog) SearchProducts(ctx context.Context, req *pb.SearchProductsRequest) (*pb.SearchProductsResponse, error) {
	span := trace.SpanFromContext(ctx)

	result, err := store.Search(ctx, req.Query)
	if err != nil {
		span.SetStatus(otelcodes.Error, err.Error())
		return nil, status.Errorf(codes.Internal, "failed to search products: %v", err)
	}

	span.SetAttributes(
		attribute.Int("demo.product.search.count", len(result)),
	)
	return &pb.SearchProductsResponse{Results: result}, nil
}

func (p *productCatalog) checkProductFailure(ctx context.Context, id string) bool {
	return flags.ProductCatalogFailure.Value(ctx, openfeature.NewTargetlessEvaluationContext(map[string]any{"product_id": id}))
}
