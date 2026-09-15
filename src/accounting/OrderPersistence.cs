// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using OpenFeature;
using Oteldemo;

namespace Accounting;

// Persists a parsed OrderResult to the accounting tables. Shared by the Kafka
// Consumer and the pgmq PgmqConsumer so both order backends write identically.
internal static class OrderPersistence
{
    private static readonly string? PrimaryConnectionString = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
    private static readonly string? AstronomyConnectionString = Environment.GetEnvironmentVariable("ASTRONOMY_DB_CONNECTION_STRING");

    // Resolves the target database per order. The supabaseDatabaseBackend flag is
    // only consulted when a secondary astronomy-db DSN is configured, so a plain
    // demo always writes to its single configured database. See supa-db-backend.md.
    private static string? ResolveConnectionString()
    {
        if (AstronomyConnectionString == null)
        {
            return PrimaryConnectionString;
        }

        var backend = Api.Instance.GetClient()
            .GetStringValueAsync("supabaseDatabaseBackend", "supabase")
            .GetAwaiter().GetResult();
        Activity.Current?.SetTag("demo.db.backend", backend);
        return backend == "astronomy_pg" ? AstronomyConnectionString : PrimaryConnectionString;
    }

    public static void Persist(ILogger logger, OrderResult order)
    {
        var dbConnectionString = ResolveConnectionString();
        if (dbConnectionString == null)
        {
            return;
        }

        using var dbContext = new DBContext(dbConnectionString);
        var orderEntity = new OrderEntity
        {
            Id = order.OrderId
        };
        dbContext.Add(orderEntity);
        foreach (var item in order.Items)
        {
            var orderItem = new OrderItemEntity
            {
                ItemCostCurrencyCode = item.Cost.CurrencyCode,
                ItemCostUnits = item.Cost.Units,
                ItemCostNanos = item.Cost.Nanos,
                ProductId = item.Item.ProductId,
                Quantity = item.Item.Quantity,
                OrderId = order.OrderId
            };

            dbContext.Add(orderItem);
        }

        var shipping = new ShippingEntity
        {
            ShippingTrackingId = order.ShippingTrackingId,
            ShippingCostCurrencyCode = order.ShippingCost.CurrencyCode,
            ShippingCostUnits = order.ShippingCost.Units,
            ShippingCostNanos = order.ShippingCost.Nanos,
            StreetAddress = order.ShippingAddress.StreetAddress,
            City = order.ShippingAddress.City,
            State = order.ShippingAddress.State,
            Country = order.ShippingAddress.Country,
            ZipCode = order.ShippingAddress.ZipCode,
            OrderId = order.OrderId
        };
        dbContext.Add(shipping);
        dbContext.SaveChanges();
    }
}
