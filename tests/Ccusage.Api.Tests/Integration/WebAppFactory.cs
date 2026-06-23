using System.Net;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
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

    /// <summary>
    /// Captures every Discord webhook POST (the "discord" named client is rerouted here) so tests can assert
    /// a send happened and inspect the embed payload, WITHOUT hitting the network. Returns 204 (Discord's real
    /// success status) so the send path reports success. Thread-safe; tests read the last payload per token.
    /// </summary>
    public sealed class DiscordCapture
    {
        private readonly object _gate = new();
        private readonly List<string> _payloads = new();
        private readonly List<string> _urls = new();

        public void Record(string payload, string url)
        {
            lock (_gate) { _payloads.Add(payload); _urls.Add(url); }
        }
        public IReadOnlyList<string> Payloads { get { lock (_gate) return _payloads.ToArray(); } }
        /// <summary>The request URI each Discord POST was sent to (so a test can assert WHICH webhook was hit).</summary>
        public IReadOnlyList<string> Urls { get { lock (_gate) return _urls.ToArray(); } }
        public int Count { get { lock (_gate) return _payloads.Count; } }
    }

    public DiscordCapture Discord { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Swap Google's real token validation for a fake the tests can drive (see FakeGoogleTokenValidator).
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IGoogleTokenValidator>();
            services.AddSingleton<IGoogleTokenValidator, FakeGoogleTokenValidator>();

            // Reroute the "discord" HttpClient to an in-memory capturing handler (no network; deterministic
            // 204). Lets recap/digest tests assert a send + inspect the payload, and keeps existing
            // fire-and-forget tests valid (they assert independence, not forward failure).
            services.AddSingleton(Discord);
            services.AddHttpClient("discord")
                .ConfigurePrimaryHttpMessageHandler(sp =>
                    new CapturingDiscordHandler(sp.GetRequiredService<DiscordCapture>()));

            // The Family Hub reminder/timer tick runs on a 30s background loop in production. In tests we
            // drive it deterministically (FamilyRemindersTimerTests invoke TickAsync directly with a fixed
            // clock), so remove ONLY that hosted loop to keep per-tick notification counts exact (other
            // hosted services — e.g. the request-log writer — stay, since some tests rely on them).
            var familyTick = services.FirstOrDefault(d =>
                d.ServiceType == typeof(IHostedService)
                && d.ImplementationType == typeof(FamilyReminderService));
            if (familyTick is not null) services.Remove(familyTick);

            // Stamp a deterministic client IP before the app pipeline runs (the TestServer otherwise
            // leaves RemoteIpAddress null). UseForwardedHeaders won't override it absent an X-Forwarded-For.
            services.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, RemoteIpStartupFilter>();
        });
    }

    /// <summary>Records the JSON body of every Discord webhook POST and returns 204 No Content (Discord's
    /// real success status), so the SSRF allowlist + post path run for real but no network call is made.</summary>
    private sealed class CapturingDiscordHandler(DiscordCapture capture) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.Content is not null)
                capture.Record(await request.Content.ReadAsStringAsync(ct), request.RequestUri?.ToString() ?? "");
            return new HttpResponseMessage(HttpStatusCode.NoContent) { RequestMessage = request };
        }
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
