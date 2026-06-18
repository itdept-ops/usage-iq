using System.Net;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Testcontainers.PostgreSql;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Shares a single <see cref="WebAppFactory"/> across all integration test classes and serializes
/// them into one xUnit collection. Required because <see cref="WebAppFactory"/> configures the app
/// through <em>process-global environment variables</em> (Program.cs reads config eagerly): two
/// factories booting in parallel would clobber each other's connection string / JWT key, pointing
/// one app at the other's database. One shared factory ⇒ one container, env vars set once.
/// </summary>
[CollectionDefinition(Name)]
public sealed class IntegrationCollection : ICollectionFixture<WebAppFactory>
{
    public const string Name = "integration";
}

/// <summary>
/// Boots the real API against a throwaway PostgreSQL container (Testcontainers).
///
/// Program.cs reads its config (connection string, JWT key) <em>eagerly</em>, before the host
/// is built, so a <c>ConfigureAppConfiguration</c> override would lose to the eager reads and to
/// appsettings.Local.json. Instead we set real environment variables here (CreateBuilder folds
/// them in first) and flip SkipLocalSettings so the local secrets file is never loaded. Migrations
/// and the admin seed run on startup, so the tests exercise the genuine auth/permission pipeline.
/// </summary>
public sealed class WebAppFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string Key = "usage-iq-integration-test-signing-key-32-bytes-min!";
    public const string AdminEmail = "admin@test.local";

    /// <summary>
    /// The TestServer leaves <c>Connection.RemoteIpAddress</c> null; a startup filter stamps this
    /// known value early in the pipeline so server-observed-IP code (login history, IP logging) has
    /// a deterministic, non-empty client IP to record — mirroring production where there always is one.
    /// </summary>
    public const string TestClientIp = "203.0.113.7";

    /// <summary>
    /// Lets a test override the stamped immediate-peer IP for a single request via the
    /// <c>X-Test-Peer-Ip</c> header — used to simulate the request arriving from a trusted private
    /// proxy (nginx) so <c>UseForwardedHeaders</c> will actually unwind an X-Forwarded-For chain.
    /// Absent the header the default public <see cref="TestClientIp"/> is stamped.
    /// </summary>
    public const string PeerIpHeader = "X-Test-Peer-Ip";

    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();

    private static readonly string[] OwnedVars =
    {
        "SkipLocalSettings", "ConnectionStrings__Default", "Jwt__Key", "Jwt__Issuer",
        "Jwt__Audience", "Jwt__ExpiryMinutes", "Google__ClientId", "Auth__AdminEmails__0",
        "AutoSync__Enabled", "RateLimiting__AuthPermitLimit",
    };

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();

        // Set before the host first builds (lazy, on first CreateClient) so the eager config
        // reads in Program.cs pick these up.
        Environment.SetEnvironmentVariable("SkipLocalSettings", "true");
        Environment.SetEnvironmentVariable("ConnectionStrings__Default", _pg.GetConnectionString());
        Environment.SetEnvironmentVariable("Jwt__Key", Key);
        Environment.SetEnvironmentVariable("Jwt__Issuer", "usage-iq");
        Environment.SetEnvironmentVariable("Jwt__Audience", "usage-iq");
        Environment.SetEnvironmentVariable("Jwt__ExpiryMinutes", "60");
        Environment.SetEnvironmentVariable("Google__ClientId", "test-client-id.apps.googleusercontent.com");
        Environment.SetEnvironmentVariable("Auth__AdminEmails__0", AdminEmail);
        Environment.SetEnvironmentVariable("AutoSync__Enabled", "false");
        // Every integration test stamps the same client IP, so all /api/auth/google calls across the
        // serialized collection fall into one rate-limit partition. Raise the per-IP login cap well above
        // the suite's cumulative login count so auth tests don't flake on a shared-partition 429.
        Environment.SetEnvironmentVariable("RateLimiting__AuthPermitLimit", "100000");
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        foreach (var v in OwnedVars)
            Environment.SetEnvironmentVariable(v, null);
        await base.DisposeAsync();
        await _pg.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Swap Google's real token validation for a fake the tests can drive (see FakeGoogleTokenValidator).
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IGoogleTokenValidator>();
            services.AddSingleton<IGoogleTokenValidator, FakeGoogleTokenValidator>();

            // Stamp a deterministic client IP before the app pipeline runs (the TestServer otherwise
            // leaves RemoteIpAddress null). UseForwardedHeaders won't override it absent an X-Forwarded-For.
            services.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, RemoteIpStartupFilter>();
        });
    }

    private sealed class RemoteIpStartupFilter : Microsoft.AspNetCore.Hosting.IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (ctx, nextMw) =>
            {
                // A test may stamp a trusted-private peer (simulating nginx) so UseForwardedHeaders
                // unwinds the X-Forwarded-For chain; otherwise stamp the default public client IP.
                var peer = ctx.Request.Headers.TryGetValue(PeerIpHeader, out var v) && !string.IsNullOrEmpty(v)
                    ? v.ToString()
                    : TestClientIp;
                ctx.Connection.RemoteIpAddress = IPAddress.Parse(peer);
                await nextMw();
            });
            next(app);
        };
    }
}
