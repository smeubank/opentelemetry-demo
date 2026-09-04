// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Accounting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Sentry;

// Sentry reads SENTRY_DSN / SENTRY_ENVIRONMENT / SENTRY_RELEASE from the
// environment. A blank/absent DSN disables Sentry. Tracing is owned by
// OpenTelemetry, so Sentry tracing is disabled here.
using var sentry = SentrySdk.Init(o =>
{
    o.TracesSampleRate = 0;
});

Console.WriteLine("Accounting service started");

Environment.GetEnvironmentVariables()
    .FilterRelevant()
    .OutputInOrder();

var host = Host.CreateDefaultBuilder(args)
    .ConfigureServices(services =>
    {
        services.AddHostedService<Consumer>();
    })
    .Build();

await host.RunAsync();
