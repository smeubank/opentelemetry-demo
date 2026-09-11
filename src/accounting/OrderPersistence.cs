// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;
using Oteldemo;

namespace Accounting;

// Persists a parsed OrderResult to the accounting tables. Shared by the Kafka
// Consumer and the pgmq PgmqConsumer so both order backends write identically.
internal static class OrderPersistence
{
    public static void Persist(ILogger logger, OrderResult order)
    {
        var dbConnectionString = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
        if (dbConnectionString == null)
        {
            return;
        }

        using var dbContext = new DBContext();
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
