// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Accounting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using OpenFeature;
using OpenFeature.Contrib.Providers.Flagd;
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

// FlagdProvider reads FLAGD_HOST / FLAGD_PORT from the environment. Without
// FLAGD_HOST the no-op provider stays in place and flag reads return their
// code defaults, keeping the supabaseDatabaseBackend flag inert.
if (Environment.GetEnvironmentVariable("FLAGD_HOST") != null)
{
    await Api.Instance.SetProviderAsync(new FlagdProvider());
}

var host = Host.CreateDefaultBuilder(args)
    .ConfigureServices(services =>
    {
        services.AddHostedService<Consumer>();
        services.AddHostedService<PgmqConsumer>();
    })
    .Build();

await host.RunAsync();
