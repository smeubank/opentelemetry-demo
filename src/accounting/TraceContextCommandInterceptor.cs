// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using System.Data.Common;
using System.Diagnostics;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Accounting;

// Appends a SQLCommenter traceparent comment to every statement so pg_tracing
// on the astronomy-db can stitch its server-side spans into the app trace.
// Trailing placement matches the sqlcommenter spec and otelsql's output.
// Harmless against Supabase, which ignores the comment today. Npgsql
// auto-prepare is not enabled, so per-statement comment churn cannot bloat a
// prepared-statement cache. See supa-db-backend.md.
internal sealed class TraceContextCommandInterceptor : DbCommandInterceptor
{
    public static readonly TraceContextCommandInterceptor Instance = new();

    private static void Stamp(DbCommand command)
    {
        var activity = Activity.Current;
        if (activity is { IdFormat: ActivityIdFormat.W3C } &&
            !command.CommandText.Contains("/*traceparent=", StringComparison.Ordinal))
        {
            command.CommandText = $"{command.CommandText} /*traceparent='{activity.Id}'*/";
        }
    }

    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        Stamp(command);
        return result;
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        Stamp(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        Stamp(command);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Stamp(command);
        return ValueTask.FromResult(result);
    }

    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        Stamp(command);
        return result;
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<object> result, CancellationToken cancellationToken = default)
    {
        Stamp(command);
        return ValueTask.FromResult(result);
    }
}
