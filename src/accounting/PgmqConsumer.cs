// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Text.Json;
using Google.Protobuf;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using Oteldemo;

namespace Accounting;

// Opt-in Supabase Queues (pgmq) poller: the alternative to the Kafka Consumer. It
// runs concurrently with the Kafka consumer; the checkout producer decides which
// backend each order lands on via the supabaseOrderQueueBackend flag. Enabled when
// QUEUE_PGMQ_ENABLED is truthy and DB_CONNECTION_STRING is set.
//
// Unlike Kafka, pgmq has no messaging auto-instrumentation, so the consumer span and
// trace propagation are hand-written: the W3C traceparent rides inside the JSON
// envelope { "traceparent": "...", "order": { <OrderResult as JSON> } }.
internal class PgmqConsumer : BackgroundService
{
    private const string QueueName = "orders_accounting";
    private const int VisibilityTimeoutSeconds = 30;
    private const int ReadBatchSize = 10;

    private readonly ILogger _logger;
    private readonly string? _dbConnectionString;
    private readonly bool _enabled;
    private static readonly ActivitySource MyActivitySource = new("Accounting.Consumer");

    public PgmqConsumer(ILogger<PgmqConsumer> logger)
    {
        _logger = logger;
        _dbConnectionString = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
        var flag = Environment.GetEnvironmentVariable("QUEUE_PGMQ_ENABLED");
        _enabled = _dbConnectionString != null
            && (string.Equals(flag, "true", StringComparison.OrdinalIgnoreCase) || flag == "1");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled)
        {
            return;
        }

        await Task.Yield();
        Log.PgmqConnecting(_logger, QueueName);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var conn = new NpgsqlConnection(_dbConnectionString);
                await conn.OpenAsync(stoppingToken);

                while (!stoppingToken.IsCancellationRequested)
                {
                    var processed = await PollOnce(conn, stoppingToken);
                    if (processed == 0)
                    {
                        await Task.Delay(TimeSpan.FromMilliseconds(500), stoppingToken);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                Log.PgmqPollError(_logger, ex);
                await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
            }
        }
    }

    private async Task<int> PollOnce(NpgsqlConnection conn, CancellationToken ct)
    {
        var messages = new List<(long MsgId, string Text)>();

        await using (var cmd = new NpgsqlCommand("SELECT msg_id, message::text FROM pgmq.read($1, $2, $3)", conn))
        {
            cmd.Parameters.AddWithValue(QueueName);
            cmd.Parameters.AddWithValue(VisibilityTimeoutSeconds);
            cmd.Parameters.AddWithValue(ReadBatchSize);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                messages.Add((reader.GetInt64(0), reader.GetString(1)));
            }
        }

        foreach (var (msgId, text) in messages)
        {
            await ProcessAndDelete(conn, msgId, text, ct);
        }

        return messages.Count;
    }

    private async Task ProcessAndDelete(NpgsqlConnection conn, long msgId, string text, CancellationToken ct)
    {
        // Redelivery after the visibility timeout is safe (persistence dedupes on the
        // unique order id), so keep the message on a persistence error and only delete
        // once processed. A parse failure is a poison message we drop by deleting.
        var delete = true;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            ActivityContext parentContext = default;
            if (root.TryGetProperty("traceparent", out var tp) && tp.GetString() is { } traceparent)
            {
                ActivityContext.TryParse(traceparent, null, out parentContext);
            }

            using var activity = MyActivitySource.StartActivity("order-consumed", ActivityKind.Consumer, parentContext);
            activity?.SetTag("messaging.system", "pgmq");
            activity?.SetTag("messaging.operation", "receive");
            activity?.SetTag("messaging.destination.name", QueueName);
            activity?.SetTag("demo.queue.backend", "pgmq");
            activity?.SetTag("demo.queue.name", QueueName);

            var orderJson = root.GetProperty("order").GetRawText();
            var order = JsonParser.Default.Parse<OrderResult>(orderJson);
            Log.OrderReceivedMessage(_logger, order);

            try
            {
                OrderPersistence.Persist(_logger, order);
            }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                Log.DuplicateOrderSkipped(_logger);
            }
            catch (Exception ex)
            {
                Log.OrderParsingFailed(_logger, ex);
                delete = false;
            }
        }
        catch (Exception ex)
        {
            Log.OrderParsingFailed(_logger, ex);
        }

        if (delete)
        {
            await using var del = new NpgsqlCommand("SELECT pgmq.delete($1, $2)", conn);
            del.Parameters.AddWithValue(QueueName);
            del.Parameters.AddWithValue(msgId);
            await del.ExecuteNonQueryAsync(ct);
        }
    }
}
