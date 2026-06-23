using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.HttpOverrides;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Hubs;
using Ccusage.Api.Infrastructure;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
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
builder.Services.AddScoped<IngestWriteService>();
builder.Services.AddScoped<CostRecomputeService>();
builder.Services.AddScoped<UsageQueries>();
builder.Services.AddSingleton<IGoogleTokenValidator, GoogleTokenValidator>();
builder.Services.AddSingleton<TokenProtector>();

// Payments holds the OWNER's intentionally-PUBLIC pay-me handles (CashApp/PayPal/Venmo) shown by the Bill
// Splitter to people who owe. A single global set for the deployment, not per-user. NOT secrets, but still
// never committed with real values: appsettings.json ships placeholders; real values live in the git-ignored
// appsettings.Local.json locally / Payments__CashApp etc. env (SSM) in prod. They are never logged.
builder.Services.Configure<PaymentsOptions>(builder.Configuration.GetSection(PaymentsOptions.SectionName));
builder.Services.AddScoped<GoogleAuthService>();
builder.Services.AddScoped<CurrentUserAccessor>();
builder.Services.AddScoped<CurrentHouseholdAccessor>();
// Family Hub F2: the background tick that fires due reminders and completes finished shared timers,
// delivering each as an in-app notification (bell + toast + unread) via ChatNotificationService.
builder.Services.AddHostedService<FamilyReminderService>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<SyncCoordinator>();
builder.Services.AddHostedService<AutoSyncBackgroundService>();

// In-memory online-users presence. Fed by PresenceMiddleware on every authenticated request
// (the SPA's existing /me + /sync/status polls double as the heartbeat); read by GET /api/presence.
builder.Services.AddSingleton<PresenceTracker>();

// Request/response action log: a bounded queue fed by middleware, drained by a background writer.
builder.Services.AddSingleton<RequestLogQueue>();
builder.Services.AddHostedService<RequestLogWriter>();
builder.Services.AddSingleton<AiUsageLogQueue>();
builder.Services.AddHostedService<AiUsageLogWriter>();

// Discord notifications: digest/alert sender + a minute-tick scheduler.
builder.Services.AddHttpClient();
// The "discord" client must NOT follow redirects — otherwise an allowlisted host could 3xx the
// request onward to an internal address, defeating the SSRF allowlist in DiscordNotifier.
builder.Services.AddHttpClient("discord").ConfigurePrimaryHttpMessageHandler(() =>
    new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(5) });
builder.Services.AddScoped<DiscordNotifier>();
builder.Services.AddHostedService<NotificationBackgroundService>();
// Per-user notification → personal-Discord forwarder: a SINGLETON queue (holds the channel + per-user
// rate buckets) that ALSO runs as the hosted draining service. The fan-out path enqueues fire-and-forget;
// the worker decrypts each user's webhook in-memory at send time, never blocking the request path.
builder.Services.AddSingleton<DiscordForwarder>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DiscordForwarder>());
// Personal weekly recap composer: aggregates the caller's OWN week + sends it to their OWN webhook (reusing
// the per-user encrypted/allowlisted send path). Scoped — it opens its own DB/protector/notifier scope. The
// minute-tick NotificationBackgroundService drives the Sunday send; the send-now endpoint drives a preview.
builder.Services.AddScoped<WeeklyRecapComposer>();

// Food & fitness tracker: USDA FoodData Central proxy. The api_key is a secret (appsettings.Local.json
// locally / Usda__ApiKey env var in prod) and is never logged; when blank the food lookup endpoints
// return 503 and the rest of the tracker still works. The host is fixed (from Usda:BaseUrl), never
// user-controlled, so no SSRF allowlist is needed. Responses are cached to respect the key's rate limit.
builder.Services.Configure<UsdaOptions>(builder.Configuration.GetSection(UsdaOptions.SectionName));
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient(UsdaFoodService.HttpClientName,
    c => c.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddScoped<UsdaFoodService>();

// FatSecret is the SECONDARY food provider (the search proxy falls back to it only when USDA is
// unconfigured or returns nothing). ClientId/ClientSecret are secrets (appsettings.Local.json locally /
// FatSecret__ClientId + FatSecret__ClientSecret env vars in prod) and are never logged; when either is
// blank FatSecret is disabled. The hosts are fixed (FatSecret:TokenUrl/ApiUrl), never user-controlled.
builder.Services.Configure<FatSecretOptions>(builder.Configuration.GetSection(FatSecretOptions.SectionName));
builder.Services.AddHttpClient(FatSecretFoodService.HttpClientName,
    c => c.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddScoped<FatSecretFoodService>();

// WorkoutX is the exercise-catalog provider for the add-exercise dialog (browse/search 1300+ exercises
// with GIF demos). The ApiKey is a secret (appsettings.Local.json locally / WorkoutX__ApiKey env var in
// prod), sent only as the X-WorkoutX-Key header and never logged; when blank the WorkoutX endpoints
// return 503 and the rest of the tracker still works. The host is fixed (WorkoutX:BaseUrl), never
// user-controlled (no SSRF). Search responses are cached to respect the key's rate limit; GIFs are
// proxied server-side because the provider rejects gif requests that lack the key.
builder.Services.Configure<WorkoutXOptions>(builder.Configuration.GetSection(WorkoutXOptions.SectionName));
builder.Services.AddHttpClient(WorkoutXService.HttpClientName,
    c => c.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddScoped<WorkoutXService>();

// Gemini powers the tracker's AI-assist endpoints (estimate macros, suggest a goal, estimate exercise
// calories). The ApiKey is a secret (appsettings.Local.json locally / Gemini__ApiKey env var in prod,
// sourced from SSM /usage-iq/gemini-api-key), sent only as the x-goog-api-key header and never logged;
// when blank the /api/ai endpoints return 503 and the rest of the tracker still works. The BaseAddress is
// FIXED below (not user-controlled), so the model id / prompts can never redirect the call (no SSRF).
builder.Services.Configure<GeminiOptions>(builder.Configuration.GetSection(GeminiOptions.SectionName));
builder.Services.AddHttpClient(GeminiService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("https://generativelanguage.googleapis.com");
    c.Timeout = TimeSpan.FromSeconds(20);
});
builder.Services.AddScoped<GeminiService>();

// OpenWeather powers the Family Hub "Today" weather card. The ApiKey is a secret (appsettings.Local.json
// locally / OpenWeather__ApiKey env var in prod); when blank the card simply hides and /today still works.
// The BaseAddress is FIXED below (not user-controlled), so the location/key can never redirect the call.
builder.Services.Configure<OpenWeatherOptions>(builder.Configuration.GetSection(OpenWeatherOptions.SectionName));
builder.Services.AddHttpClient(WeatherService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("https://api.openweathermap.org");
    c.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddScoped<WeatherService>();
// Family Hub F3: the Today aggregator + the daily-briefing composer/deliverer (driven by the reminder tick).
builder.Services.AddScoped<FamilyTodayService>();
builder.Services.AddScoped<FamilyBriefingService>();

// Location (GPS): two free, keyless geocoders, both with FIXED hosts (no SSRF), cached (IMemoryCache),
// rate-limited, and graceful-null so they NEVER throw into the request/ingest path.
//   - ip-api.com  (IP -> coarse geo, ~45/min)        : gives desktops a "fleet location" via their PublicIp.
//   - Nominatim/OSM (lat/lng -> city, 1 req/s + UA)  : attaches a coarse city to a recorded GPS fix.
builder.Services.AddHttpClient(IpGeoService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("http://ip-api.com");
    c.Timeout = TimeSpan.FromSeconds(8);
});
builder.Services.AddScoped<IpGeoService>();
builder.Services.AddHttpClient(ReverseGeocodeService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("https://nominatim.openstreetmap.org");
    c.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddScoped<ReverseGeocodeService>();
// Background pass that fills in IP-geo (city/lat/lng) for MachineInfo rows whose PublicIp hasn't been
// resolved yet (or is stale) — keeps the fleet map populated without blocking the ingest hot path.
builder.Services.AddHostedService<MachineGeoBackfillService>();

// Family Hub F6: Google Calendar via the OAuth 2.0 authorization-CODE flow (offline access) — a separate
// concern from Google sign-in. The OAuth CLIENT SECRET (Google:ClientSecret, blank in dev → calendar is
// "not configured") and the per-user REFRESH TOKEN are secrets that never appear in any response/log; the
// refresh token is stored AES-GCM-encrypted via TokenProtector. All HTTP targets are FIXED Google
// endpoints (oauth2.googleapis.com token + www.googleapis.com calendar), never user-controlled — no SSRF.
builder.Services.AddHttpClient(GoogleCalendarService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("https://www.googleapis.com");
    c.Timeout = TimeSpan.FromSeconds(15);
});
builder.Services.AddScoped<GoogleCalendarService>();

// Real-time chat + in-app notifications. The hub addresses individual users by their email claim
// (EmailUserIdProvider) so per-user pushes work across all of a user's connections; the fan-out
// service is the shared broadcast/notify path used by both the REST endpoints and the hub.
builder.Services.AddSignalR();
builder.Services.AddSingleton<IUserIdProvider, EmailUserIdProvider>();
builder.Services.AddScoped<ChatNotificationService>();
builder.Services.AddScoped<ChatLocationShareService>();
// Social activity feed: the fire-and-forget emitter for the event spine (no-op when the actor isn't sharing).
builder.Services.AddScoped<ActivityEmitter>();
builder.Services.AddScoped<RuleEvaluator>();

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
        // Browsers can't set Authorization headers on a WebSocket handshake, so SignalR passes the
        // JWT as the ?access_token query param. Lift it into the token slot for hub routes only
        // (never for normal API calls, which must keep using the Authorization header).
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var token = ctx.Request.Query["access_token"];
                var path = ctx.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(token) && path.StartsWithSegments("/api/hubs"))
                    ctx.Token = token;
                return Task.CompletedTask;
            },
            // Session invalidation (force-logout): the token's "sv" claim must still match the user's
            // current SessionVersion. An admin bumping SessionVersion (POST /api/users/{id}/logout)
            // invalidates every outstanding token without disabling the account. A MISSING "sv" claim
            // is treated as 0, so tokens minted before this field existed stay valid while the user's
            // SessionVersion is still its default 0 — no mass-logout on deploy.
            OnTokenValidated = async ctx =>
            {
                var email = ctx.Principal?.FindFirst("email")?.Value?.Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(email))
                {
                    ctx.Fail("No email claim.");
                    return;
                }

                var db = ctx.HttpContext.RequestServices.GetRequiredService<UsageDbContext>();
                var user = await db.Users.AsNoTracking().Include(u => u.Permissions)
                    .FirstOrDefaultAsync(u => u.Email == email, ctx.HttpContext.RequestAborted);
                if (user is null)
                {
                    // Unknown user: leave the request to the per-endpoint permission filter (403), which
                    // matches today's behaviour for a valid token whose account doesn't exist.
                    return;
                }

                var tokenSv = int.TryParse(ctx.Principal?.FindFirst("sv")?.Value, out var sv) ? sv : 0;
                if (tokenSv != user.SessionVersion)
                {
                    ctx.Fail("Session has been invalidated.");
                    return;
                }

                // Stash the loaded user so CurrentUserAccessor can reuse it (avoids a duplicate DB hit).
                ctx.HttpContext.Items[CurrentUserAccessor.LoadedUserKey] = user;
            },
        };
    });
builder.Services.AddAuthorization();

// The API runs behind a chain of reverse proxies (Caddy → the bundled nginx → Kestrel, plus any AWS
// infra in front), so honor X-Forwarded-For — otherwise every request appears to come from the
// nearest proxy and per-IP rate limits / logged IPs (login history, the Activity request log, and the
// Fleet machine IP) would all collapse to one private address.
//
// ForwardLimit = null unwinds the FULL chain of *trusted* proxies rather than a fixed number of hops:
// with a hard limit only the last N hops are unwound, so behind the multi-hop production chain the
// real client IP is never reached and RemoteIpAddress stays a private/proxy address. Leaving it null
// is safe here only because the trust is bounded by KnownNetworks below — unwinding stops at the first
// address that is NOT in a trusted private range, which is the leftmost public IP (the real client).
// Kestrel is never publicly reachable (the api container publishes no host port; it is reached only
// over the Docker network via nginx), so the X-Forwarded-For chain can only have been written by our
// own trusted private proxies — a client cannot spoof a public hop into the trusted middle of it.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = null;
    o.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(IPAddress.Parse("10.0.0.0"), 8));
    o.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(IPAddress.Parse("172.16.0.0"), 12));
    o.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(IPAddress.Parse("192.168.0.0"), 16));
});

builder.Services.AddScoped<AuditLogger>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks().AddDbContextCheck<UsageDbContext>("database");
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // Per-IP login cap. Config-bound (default 20/min) so the integration tests — which all share one
    // stamped client IP and so one rate-limit partition — can raise it and not flake on cross-test 429s.
    var authPermitLimit = builder.Configuration.GetValue<int?>("RateLimiting:AuthPermitLimit") ?? 20;
    o.AddPolicy("auth", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = authPermitLimit, QueueLimit = 0 }));
    // The "send test" button pokes Discord; cap it so it can't be used to spam the channel.
    o.AddPolicy("notif-test", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 5, QueueLimit = 0 }));
    // Public share links are unauthenticated; cap per-IP to blunt scraping/abuse.
    o.AddPolicy("share", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 60, QueueLimit = 0 }));
    // Reporter ingest is key-authenticated but anonymous at the HTTP layer; cap per-IP generously so a
    // first-run backfill (the reporter coalesces rows across files into ~rows/batchSize requests) sails
    // through, while brute-forcing a 256-bit key stays futile.
    o.AddPolicy("ingest", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 600, QueueLimit = 0 }));
    // Chat sends: cap per-email so one account can't flood a channel (~30 messages/min).
    o.AddPolicy("chat", http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 30, QueueLimit = 0 }));
    // AI-assist (Gemini) calls cost tokens; cap per-email so one account can't run up the bill (~15/min).
    o.AddPolicy(AiEndpoints.RateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 15, QueueLimit = 0 }));
    // The multimodal photo routes (photo-meal / read-label) are the most expensive AI calls (a whole image
    // per request); give them a tighter per-email cap (~5/min) on top of the shared "ai" group limit.
    o.AddPolicy(AiEndpoints.PhotoRateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 5, QueueLimit = 0 }));
    // Provider-backed tracker lookups (food/exercise search + GIF proxy) are NOT Gemini calls; give them
    // their own generous per-email buckets so type-ahead search / a GIF grid can't starve the AI budget.
    o.AddPolicy(TrackerEndpoints.SearchRateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 60, QueueLimit = 0 }));
    o.AddPolicy(TrackerEndpoints.GifRateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 30, QueueLimit = 0 }));
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
            OpenSignupEnabled = builder.Configuration.GetValue("Auth:OpenSignupEnabled", true),
            DefaultPermissionsCsv = builder.Configuration["Auth:DefaultPermissionsCsv"] ?? Permissions.DashboardView,
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

    // Seed the food & fitness exercise library once (idempotent): only when the table is empty, so
    // user/admin edits are never clobbered on restart. Mirrors the ingestion-sources seeding above.
    if (!await db.ExerciseLibrary.AnyAsync())
    {
        db.ExerciseLibrary.AddRange(ExerciseLibrarySeed.Build());
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

    // Promote/upsert: configured admins are break-glass accounts that must ALWAYS be enabled and
    // hold every permission — even if the row already exists (e.g. the account first signed in as a
    // viewer, or new permission keys were added since it was seeded). This is what keeps the owner
    // from being locked out, so it is deliberately not create-only.
    var adminEmails = Emails("Auth:AdminEmails");
    foreach (var email in adminEmails)
    {
        var admin = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(x => x.Email == email);
        if (admin is null)
        {
            db.Users.Add(new AppUser
            {
                Email = email, IsEnabled = true, CreatedUtc = DateTime.UtcNow,
                Permissions = Permissions.All.Select(p => new UserPermission { Permission = p }).ToList(),
            });
        }
        else
        {
            admin.IsEnabled = true;
            var have = admin.Permissions.Select(p => p.Permission).ToHashSet(StringComparer.Ordinal);
            foreach (var p in Permissions.All.Where(p => !have.Contains(p)))
                admin.Permissions.Add(new UserPermission { Permission = p });
        }
        await db.SaveChangesAsync();
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

// Resolve the real client IP from the proxy hop first, so rate-limit partitions and the logged IP
// reflect the actual caller rather than the nginx container address.
app.UseForwardedHeaders();

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

// After auth so HttpContext.User is populated: best-effort stamp the caller as "online".
app.UseMiddleware<PresenceMiddleware>();

app.UseRateLimiter();

// Cap the ingest request body BEFORE it is buffered/deserialized (model binding runs before the
// ingest-key endpoint filter, so without this an unauthenticated caller could force a large parse).
// Sized to a max 5000-row batch with headroom; every other route keeps Kestrel's default limit.
app.Use(async (ctx, next) =>
{
    if (HttpMethods.IsPost(ctx.Request.Method)
        && string.Equals(ctx.Request.Path.Value, "/api/ingest", StringComparison.OrdinalIgnoreCase))
    {
        var feat = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        if (feat is { IsReadOnly: false }) feat.MaxRequestBodySize = 4 * 1024 * 1024;
    }
    await next();
});

app.MapHealthChecks("/health/ready");
app.MapAuthEndpoints();
app.MapUsersEndpoints();
app.MapApiEndpoints();
app.MapPresenceEndpoints();
app.MapLocationEndpoints();
app.MapSavedViewsEndpoints();
app.MapObservabilityEndpoints();
app.MapNotificationsEndpoints();
app.MapShareEndpoints();
app.MapBillEndpoints();
app.MapIngestEndpoints();
app.MapFleetEndpoints();
app.MapChatEndpoints();
app.MapChatLocationShareEndpoints();
app.MapContactsEndpoints();
app.MapPeopleEndpoints();
app.MapInboxEndpoints();
app.MapTrackerEndpoints();
app.MapHardChallengeEndpoints();
app.MapTrophyEndpoints();
app.MapFeedEndpoints();
app.MapRulesEndpoints();
app.MapAiEndpoints();
app.MapFamilyEndpoints();
app.MapFamilyLocationsEndpoints();
app.MapFamilyNotesListsEndpoints();
app.MapFamilyRemindersTimersEndpoints();
app.MapFamilyTodayEndpoints();
app.MapFamilyMealsChoresEndpoints();
app.MapFamilyFinanceEndpoints();
app.MapFamilyCalendarEndpoints();
app.MapFamilyPollsEndpoints();
app.MapFamilyQuickAddEndpoints();
app.MapFamilyAssistantEndpoints();
app.MapCycleEndpoints();
app.MapCycleOverlayEndpoints();
app.MapIdentityEndpoints();
app.MapHub<ChatHub>("/api/hubs/chat");
app.MapGet("/", () => app.Environment.IsDevelopment()
    ? Results.Redirect("/swagger")
    : Results.Ok(new { service = "Usage IQ API" }));

app.Run();

// Exposed so integration tests can spin up the app via WebApplicationFactory<Program>.
public partial class Program { }
