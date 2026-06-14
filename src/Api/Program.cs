using System.Net.Http;
using System.Text;
using System.Threading.RateLimiting;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Infrastructure;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// Secrets (Google client id/secret, JWT signing key, email allowlist) live in this
// git-ignored file (baked into the Docker image at build time). Integration tests set
// SkipLocalSettings=true (env var) and inject config via environment variables instead,
// so this real secrets file never shadows the test config.
if (!builder.Configuration.GetValue("SkipLocalSettings", false))
    builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

var conn = builder.Configuration.GetConnectionString("Default")
           ?? "Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password=ccusage_dev_pw";

builder.Services.AddDbContext<UsageDbContext>(o => o
    .UseNpgsql(conn, npgsql =>
        // Resilience against transient DB blips (failover, connection drops). The two endpoints
        // that open user-initiated transactions wrap them in the execution strategy accordingly.
        npgsql.EnableRetryOnFailure(maxRetryCount: 5, maxRetryDelay: TimeSpan.FromSeconds(10), errorCodesToAdd: null))
    // Every First/FirstOrDefault in the app filters by a unique key, so these warnings are false
    // positives here — silence them to keep the logs clean.
    .ConfigureWarnings(w => w.Ignore(
        CoreEventId.FirstWithoutOrderByAndFilterWarning,
        CoreEventId.RowLimitingOperationWithoutOrderByWarning)));
builder.Services.AddScoped<JsonlIngestionService>();
builder.Services.AddScoped<CostRecomputeService>();
builder.Services.AddScoped<UsageQueries>();
builder.Services.AddSingleton<IGoogleTokenValidator, GoogleTokenValidator>();
builder.Services.AddScoped<GoogleAuthService>();
builder.Services.AddScoped<CurrentUserAccessor>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<SyncCoordinator>();
builder.Services.AddHostedService<AutoSyncBackgroundService>();

// Request/response action log: a bounded queue fed by middleware, drained by a background writer.
builder.Services.AddSingleton<RequestLogQueue>();
builder.Services.AddHostedService<RequestLogWriter>();

// Discord notifications: digest/alert sender + a minute-tick scheduler.
builder.Services.AddHttpClient();
// The "discord" client must NOT follow redirects — otherwise an allowlisted host could 3xx the
// request onward to an internal address, defeating the SSRF allowlist in DiscordNotifier.
builder.Services.AddHttpClient("discord").ConfigurePrimaryHttpMessageHandler(() =>
    new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(5) });
builder.Services.AddScoped<DiscordNotifier>();
builder.Services.AddHostedService<NotificationBackgroundService>();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var corsOrigin = builder.Configuration["Cors:AllowedOrigin"] ?? "http://localhost:4200";
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigin).AllowAnyHeader().AllowAnyMethod()));

// Auth: the API issues + validates its own JWT after a Google sign-in passes the allowlist.
// Fail fast on a missing/weak key — never fall back to a known key (that would let anyone forge tokens).
var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || Encoding.UTF8.GetByteCount(jwtKey) < 32)
    throw new InvalidOperationException(
        "Jwt:Key is missing or too short. Set a strong key (>= 32 bytes) in appsettings.Local.json. " +
        "The API refuses to start with a blank/weak signing key.");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidateAudience = true,
            ValidAudience = builder.Configuration["Jwt:Audience"],
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 },
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(2),
        };
    });
builder.Services.AddAuthorization();

builder.Services.AddScoped<AuditLogger>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks().AddDbContextCheck<UsageDbContext>("database");
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("auth", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 20, QueueLimit = 0 }));
    // The "send test" button pokes Discord; cap it so it can't be used to spam the channel.
    o.AddPolicy("notif-test", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 5, QueueLimit = 0 }));
});

var app = builder.Build();

// Apply migrations and seed the single settings row from configuration on first run.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
    await db.Database.MigrateAsync();

    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var claudePath = builder.Configuration["Ingestion:ClaudeProjectsPath"];
    var codexPath = builder.Configuration["Ingestion:CodexPath"];

    var appConfig = await db.AppConfigs.FirstOrDefaultAsync();
    if (appConfig is null)
    {
        db.AppConfigs.Add(new AppConfig
        {
            Id = 1,
            DisplayTimeZone = builder.Configuration["Ingestion:DisplayTimeZone"] ?? "America/New_York",
            ClaudeProjectsPath = string.IsNullOrWhiteSpace(claudePath) ? Path.Combine(home, ".claude", "projects") : claudePath,
            AutoSyncEnabled = builder.Configuration.GetValue("AutoSync:Enabled", true),
            AutoSyncIntervalSeconds = Math.Max(30, builder.Configuration.GetValue("AutoSync:IntervalSeconds", 300)),
        });
        await db.SaveChangesAsync();
    }

    // Seed the ingestion sources once; thereafter they're editable in Settings.
    if (!await db.IngestionSources.AnyAsync())
    {
        db.IngestionSources.AddRange(
            new IngestionSource { Name = "claude-code", Kind = "claude", Enabled = true,
                RootPath = string.IsNullOrWhiteSpace(claudePath) ? Path.Combine(home, ".claude", "projects") : claudePath },
            new IngestionSource { Name = "codex", Kind = "codex", Enabled = true,
                RootPath = string.IsNullOrWhiteSpace(codexPath) ? Path.Combine(home, ".codex") : codexPath });
        await db.SaveChangesAsync();
    }

    // An explicit configured/env path (e.g. a container's read-only mount) overrides the stored path.
    if (!string.IsNullOrWhiteSpace(claudePath))
        await db.IngestionSources.Where(s => s.Kind == "claude" && s.RootPath != claudePath)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RootPath, claudePath));
    if (!string.IsNullOrWhiteSpace(codexPath))
        await db.IngestionSources.Where(s => s.Kind == "codex" && s.RootPath != codexPath)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RootPath, codexPath));

    // Bootstrap users so someone can sign in and manage the rest. Admins always get every
    // permission and stay enabled (so they can't be locked out); allowlisted emails are seeded
    // once as dashboard viewers. Thereafter, manage everyone from the Users page.
    string[] Emails(string section) => (builder.Configuration.GetSection(section).Get<string[]>() ?? Array.Empty<string>())
        .Select(e => e.Trim().ToLowerInvariant()).Where(e => e.Length > 0).Distinct().ToArray();

    // Create-only: seed configured admins as full admins if they don't exist yet. We never
    // re-enable or re-grant an existing account, so changes made in the Users UI stick.
    var adminEmails = Emails("Auth:AdminEmails");
    foreach (var email in adminEmails)
    {
        if (!await db.Users.AnyAsync(x => x.Email == email))
        {
            db.Users.Add(new AppUser
            {
                Email = email, IsEnabled = true, CreatedUtc = DateTime.UtcNow,
                Permissions = Permissions.All.Select(p => new UserPermission { Permission = p }).ToList(),
            });
            await db.SaveChangesAsync();
        }
    }

    foreach (var email in Emails("Auth:AllowedEmails").Where(e => !adminEmails.Contains(e)))
    {
        if (!await db.Users.AnyAsync(x => x.Email == email))
        {
            db.Users.Add(new AppUser
            {
                Email = email, IsEnabled = true, CreatedUtc = DateTime.UtcNow,
                Permissions = new List<UserPermission> { new() { Permission = Permissions.DashboardView } },
            });
            await db.SaveChangesAsync();
        }
    }
}

// Outermost so the status it records is the final one (after the exception handler runs).
app.UseMiddleware<RequestLoggingMiddleware>();

app.UseExceptionHandler();

// Swagger (full API schema) is dev-only — don't expose the API surface to anonymous callers in prod.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapHealthChecks("/health/ready");
app.MapAuthEndpoints();
app.MapUsersEndpoints();
app.MapApiEndpoints();
app.MapObservabilityEndpoints();
app.MapNotificationsEndpoints();
app.MapGet("/", () => app.Environment.IsDevelopment()
    ? Results.Redirect("/swagger")
    : Results.Ok(new { service = "Usage IQ API" }));

app.Run();

// Exposed so integration tests can spin up the app via WebApplicationFactory<Program>.
public partial class Program { }
