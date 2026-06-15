using Ccusage.Api.Services;
using Microsoft.AspNetCore.Hosting;
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

    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();

    private static readonly string[] OwnedVars =
    {
        "SkipLocalSettings", "ConnectionStrings__Default", "Jwt__Key", "Jwt__Issuer",
        "Jwt__Audience", "Jwt__ExpiryMinutes", "Google__ClientId", "Auth__AdminEmails__0",
        "AutoSync__Enabled",
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
        });
    }
}
