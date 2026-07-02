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

var conn = builder.Configuration.GetConnectionString("Default") is { } configuredConn
           && !string.IsNullOrWhiteSpace(configuredConn)
    ? configuredConn
    : "Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password=ccusage_dev_pw";

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
builder.Services.AddScoped<MyDataExportService>();
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

// Every outbound HTTP client must refuse to auto-follow redirects. .NET only strips the Authorization
// header on a cross-host redirect — it re-sends CUSTOM auth headers (Gemini's x-goog-api-key, WorkoutX's
// X-WorkoutX-Key, etc.), so a 3xx from (or an on-path MITM of) a fixed upstream would otherwise replay a
// production secret to an attacker host, and would also turn any of these fixed-host callers into an SSRF
// pivot. Disabling redirects at the default primary handler makes every named client inherit the safe
// behaviour (new clients included); treat any 3xx as a hard failure at the call site.
builder.Services.ConfigureHttpClientDefaults(b => b.ConfigurePrimaryHttpMessageHandler(() =>
    new SocketsHttpHandler { AllowAutoRedirect = false }));

// Discord notifications: digest/alert sender + a minute-tick scheduler.
builder.Services.AddHttpClient();
// The "discord" client must NOT follow redirects — otherwise an allowlisted host could 3xx the
// request onward to an internal address, defeating the SSRF allowlist in DiscordNotifier. (The default
// above already disables redirects; this explicit handler additionally sets a tight connect timeout.)
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
    // 60s (not ~20s) because multimodal DOCUMENT parsing — e.g. extracting a week of shifts from a
    // schedule PDF/image — routinely takes 20-40s; the old 20s ceiling timed those calls out, which the
    // service caught as a failure and surfaced as a 503. Every text-only AI call still returns in a few
    // seconds, so the higher ceiling only ever gives the genuinely-slow document calls room to finish.
    // (A timeout throws a TaskCanceledException out of SendAsync and is NOT retried, so this can't double up.)
    c.Timeout = TimeSpan.FromSeconds(60);
});
builder.Services.AddScoped<GeminiService>();

// The tracker's shared per-request helpers (target-user resolution, "date-or-today", date-active goal
// targets) — ONE source of truth the food/fitness tracker, 75 Hard, and AI endpoints all resolve through.
builder.Services.AddScoped<TrackerService>();

// Resume Builder: turns the structured ResumeData into downloadable PDF/DOCX documents (ATS-plain or the
// designed style with the stored headshot). No external service / secret — pure in-process document
// generation — so it always works regardless of Gemini config.
builder.Services.AddScoped<ResumeDocumentService>();

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

// Proactive scheduled agents: the per-kind composer (deterministic floor + optional AI upgrade gated on the
// EXISTING AI keys) backing both the background tick and the preview/test endpoints, plus the minute-tick
// AgentScheduler that fires every DUE agent (stamp-first idempotency, bounded query, per-user timezone +
// quiet-hours) and delivers it to the owner's bell + opt-in web push via ChatNotificationService.
builder.Services.AddScoped<AgentComposer>();
builder.Services.AddHostedService<AgentScheduler>();

// Location (GPS): two free, keyless geocoders, both with FIXED hosts (no SSRF), cached (IMemoryCache),
// rate-limited, and graceful-null so they NEVER throw into the request/ingest path.
//   - ip-api.com  (IP -> coarse geo, ~45/min)        : gives desktops a "fleet location" via their PublicIp.
//   - Nominatim/OSM (lat/lng -> city, 1 req/s + UA)  : attaches a coarse city to a recorded GPS fix.
builder.Services.AddHttpClient(IpGeoService.HttpClientName, c =>
{
    c.BaseAddress = new Uri("http://ip-api.com");
    c.Timeout = TimeSpan.FromSeconds(8);
    // Cap buffering so a hostile/compromised upstream can't force an unbounded response into memory.
    c.MaxResponseContentBufferSize = 4 * 1024 * 1024;
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

// PROGRAM-2 #1 — Wearable / Health sync (Fitbit v1) via the OAuth 2.0 authorization-code + PKCE flow
// (offline access). The Fitbit CLIENT SECRET (Fitbit:ClientSecret, blank in dev → "not configured") and the
// per-user (ROTATING) REFRESH TOKEN are secrets that never appear in any response/log; the refresh token is
// stored AES-GCM-encrypted via TokenProtector and RE-STORED on every refresh (Fitbit rotates it). All HTTP
// targets are FIXED Fitbit endpoints (api.fitbit.com), never user-controlled — no SSRF. When the secret is
// unset everything degrades gracefully (status configured:false), exactly like GoogleCalendarService.
builder.Services.Configure<Ccusage.Api.Services.Health.FitbitOptions>(
    builder.Configuration.GetSection(Ccusage.Api.Services.Health.FitbitOptions.SectionName));
builder.Services.AddHttpClient(Ccusage.Api.Services.Health.FitbitHealthProvider.HttpClientName, c =>
{
    c.BaseAddress = new Uri("https://api.fitbit.com");
    c.Timeout = TimeSpan.FromSeconds(20);
});
builder.Services.AddScoped<Ccusage.Api.Services.Health.FitbitHealthProvider>();
// Expose the provider behind the provider-agnostic interface too (Oura slots in later).
builder.Services.AddScoped<Ccusage.Api.Services.Health.IHealthProvider>(
    sp => sp.GetRequiredService<Ccusage.Api.Services.Health.FitbitHealthProvider>());
builder.Services.AddScoped<Ccusage.Api.Services.Health.HealthSyncMapper>();
builder.Services.AddHostedService<Ccusage.Api.Services.Health.HealthSyncScheduler>();

// Web Push (background / "offline" notifications): the always-on surface that fires even with no open tab,
// alongside the SignalR live path + per-user Discord mirror. The VAPID keypair lives in config — PublicKey is
// intentionally public (handed to the browser to subscribe), PrivateKey is a SECRET (appsettings.Local.json
// locally / WebPush__PrivateKey env var in prod, sourced from SSM) and is NEVER logged or returned. When the
// keypair is UNSET the whole surface is a no-op (sender does nothing; /api/push/vapid-public returns 404).
// The named "webpush" client carries the push POSTs (rerouteable in tests). The forwarder is a SINGLETON
// queue that ALSO runs as the hosted draining service (mirrors DiscordForwarder); the fan-out enqueues
// fire-and-forget so a push never blocks/slows/fails notification creation.
builder.Services.Configure<WebPushOptions>(builder.Configuration.GetSection(WebPushOptions.SectionName));
// Like the "discord" client: an explicit no-redirect + tight-connect handler so a push endpoint can't
// 3xx-redirect the authenticated push POST onward to an internal address (SSRF defense-in-depth).
builder.Services.AddHttpClient(WebPushSender.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(15))
    .ConfigurePrimaryHttpMessageHandler(() =>
        new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(5) });
builder.Services.AddScoped<WebPushSender>();
builder.Services.AddSingleton<WebPushForwarder>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WebPushForwarder>());

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

// Fail fast on the other operationally-critical settings too, so a deploy with a dropped SSM parameter
// surfaces as a clear boot-time error instead of an opaque per-request partial outage discovered by users.
var configErrors = new List<string>();
// Google sign-in is the sole auth path — a blank client id silently breaks login for everyone.
if (string.IsNullOrWhiteSpace(builder.Configuration["Google:ClientId"]))
    configErrors.Add("Google:ClientId is not set (Google sign-in is the only auth path).");
// A blank issuer/audience silently weakens token validation (ValidateIssuer/Audience have nothing to match).
if (string.IsNullOrWhiteSpace(builder.Configuration["Jwt:Issuer"]))
    configErrors.Add("Jwt:Issuer is not set.");
if (string.IsNullOrWhiteSpace(builder.Configuration["Jwt:Audience"]))
    configErrors.Add("Jwt:Audience is not set.");
// In production the connection string MUST be explicit AND non-dev — never boot against the hardcoded
// localhost dev default (line 30-31) or the committed dev value in appsettings.json, which would only
// fail late at MigrateAsync and crash-loop the container (or worse, silently connect to a wrong/dev DB).
// A blank-check alone is insufficient: appsettings.json commits a non-blank localhost/dev Default, so a
// dropped/renamed SSM override would leave that committed value in place and pass a whitespace check.
// Reject the dev host/credential explicitly so a missing prod override fails fast regardless.
if (builder.Environment.IsProduction())
{
    var prodConn = builder.Configuration.GetConnectionString("Default");
    if (string.IsNullOrWhiteSpace(prodConn))
        configErrors.Add("ConnectionStrings:Default is not set (refusing the localhost dev fallback in Production).");
    else if (prodConn.Contains("Host=localhost", StringComparison.OrdinalIgnoreCase)
             || prodConn.Contains("Host=127.0.0.1", StringComparison.OrdinalIgnoreCase)
             || prodConn.Contains("Password=ccusage_dev_pw", StringComparison.OrdinalIgnoreCase))
        configErrors.Add("ConnectionStrings:Default is the committed localhost dev default in Production "
            + "(the ConnectionStrings__Default override from SSM is missing or mis-injected).");
}
if (configErrors.Count > 0)
    throw new InvalidOperationException(
        "The API refuses to start with missing operationally-required configuration: "
        + string.Join(" ", configErrors));

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
        // Token sources, in precedence order:
        //  1. Authorization: Bearer header — non-browser clients and the test suite (handled by the
        //     framework's default extraction when we don't set ctx.Token below).
        //  2. ?access_token query param on hub routes — the legacy SignalR handshake path (kept working).
        //  3. The HttpOnly "usage_iq_jwt" cookie — the SPA no longer holds the JWT in JS; the browser sends
        //     it automatically on same-origin API calls AND on the SignalR handshake. Only consulted when no
        //     Authorization header was sent, so a Bearer header (tests / API clients) always wins.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var path = ctx.HttpContext.Request.Path;
                var qtoken = ctx.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(qtoken) && path.StartsWithSegments("/api/hubs"))
                {
                    ctx.Token = qtoken;
                    return Task.CompletedTask;
                }
                if (!ctx.Request.Headers.ContainsKey("Authorization")
                    && ctx.Request.Cookies.TryGetValue(AuthEndpoints.JwtCookieName, out var cookieToken)
                    && !string.IsNullOrEmpty(cookieToken))
                {
                    ctx.Token = cookieToken;
                }
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

                // Enforce admin "Disable" at the authentication boundary so it contains a just-offboarded
                // account uniformly — including RequireAuthorization()-only routes (presence,
                // notifications/me/discord) that have no permission filter or inline IsEnabled guard.
                // Otherwise a disabled user's still-valid token keeps authenticating until it expires.
                if (!user.IsEnabled)
                {
                    ctx.Fail("Account is disabled.");
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
// The production chain has exactly two trusted proxy hops that write X-Forwarded-For — Caddy and the
// bundled nginx (Kestrel is the third link and only reads the header). Bounding ForwardLimit to that
// hop count (rather than null, which unwinds the entire chain) means we no longer rely solely on the
// KnownNetworks range check plus the deployment invariant that Kestrel publishes no host port: even if
// Kestrel became directly reachable, a caller could not forge extra private hops to walk RemoteIpAddress
// back to an arbitrary value — unwinding stops after two entries regardless. KnownNetworks still gates
// which addresses are trusted so a public hop (any AWS infra in front of Caddy) is never unwound.
// ForwardLimit = null unwinds the FULL chain of trusted proxies (bounded by KnownNetworks below) rather
// than a fixed hop count: unwinding stops at the first address NOT in a trusted private range — the
// leftmost public IP (the real client). A fixed hop count instead stops after N entries, so behind the
// multi-hop production chain the real client IP would never be reached. Kestrel publishes no host port
// (reached only over the Docker network via nginx), so the X-Forwarded-For chain can only have been
// written by our own trusted private proxies and a client cannot spoof a public hop into its trusted middle.
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
// The DB-connectivity check is tagged "ready" so /health/ready (below) can select ONLY readiness checks
// while /health/live stays a pure liveness probe. The container HEALTHCHECK + compose service_healthy gate
// should target /health/ready so the API is not reported healthy while Postgres is unreachable.
builder.Services.AddHealthChecks().AddDbContextCheck<UsageDbContext>("database", tags: new[] { "ready" });
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
    // "Search Everything" fans out across every domain per query; cap per-email (~30/min) so the box can't be
    // used to hammer the DB with cross-domain scans.
    o.AddPolicy(SearchEndpoints.RateLimitPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: http.User.FindFirst("email")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions { Window = TimeSpan.FromMinutes(1), PermitLimit = 30, QueueLimit = 0 }));
});

var app = builder.Build();

// Apply migrations and seed the single settings row from configuration on first run.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();

    // The boot-time migrate runs on a fresh scope OUTSIDE the request-path retry strategy, so a transient
    // DB blip (failover, a dropped connection, a brief lock) at startup would otherwise throw out of Main
    // and — on the single-instance topology — crash-loop the container into a full outage. Retry with a
    // bounded backoff so a transient blip recovers; a genuinely bad migration still throws after the last
    // attempt, exiting the process so the deploy leaves the previous image serving traffic.
    var startupLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
    const int maxMigrateAttempts = 5;
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            await db.Database.MigrateAsync();
            break;
        }
        catch (Exception ex) when (attempt < maxMigrateAttempts)
        {
            var delay = TimeSpan.FromSeconds(Math.Min(30, 2 * attempt));
            startupLog.LogWarning(ex,
                "Database migration attempt {Attempt}/{Max} failed; retrying in {Delay}s.",
                attempt, maxMigrateAttempts, delay.TotalSeconds);
            await Task.Delay(delay);
        }
    }

    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    var claudePath = builder.Configuration["Ingestion:ClaudeProjectsPath"];
    var codexPath = builder.Configuration["Ingestion:CodexPath"];
    var geminiPath = builder.Configuration["Ingestion:GeminiPath"];

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
                RootPath = string.IsNullOrWhiteSpace(codexPath) ? Path.Combine(home, ".codex") : codexPath },
            new IngestionSource { Name = "gemini", Kind = "gemini", Enabled = true,
                RootPath = string.IsNullOrWhiteSpace(geminiPath) ? Path.Combine(home, ".gemini") : geminiPath });
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
    if (!string.IsNullOrWhiteSpace(geminiPath))
        await db.IngestionSources.Where(s => s.Kind == "gemini" && s.RootPath != geminiPath)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RootPath, geminiPath));

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

// Readiness (is it ready to SERVE): runs only the "ready"-tagged checks — currently DB connectivity — so
// this returns 503 while Postgres is down. Orchestration/HEALTHCHECK should gate service_healthy on THIS.
app.MapHealthChecks("/health/ready", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
});
// Liveness (is the process up): no checks, so it never fails on a DB blip — use only to decide restarts.
app.MapHealthChecks("/health/live", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = _ => false,
});
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
app.MapSearchEndpoints();
app.MapNudgeEndpoints();
app.MapInboxEndpoints();
app.MapPushEndpoints();
app.MapTrackerEndpoints();
app.MapHealthEndpoints();
app.MapRecipeEndpoints();
app.MapResumeEndpoints();
app.MapGroceryEndpoints();
app.MapHardChallengeEndpoints();
app.MapJournalEndpoints();
app.MapHabitEndpoints();
app.MapTrophyEndpoints();
app.MapWrappedEndpoints();
app.MapWrappedShareEndpoints();
app.MapInsightsEndpoints();
app.MapFeedEndpoints();
app.MapPactEndpoints();
app.MapPublicEndpoints();
app.MapRulesEndpoints();
app.MapAgentsEndpoints();
app.MapAgentInboxEndpoints();
app.MapAiEndpoints();
app.MapDayRecapEndpoints();
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
app.MapMedsEndpoints();
app.MapIdentityEndpoints();
// CloseOnAuthenticationExpiration tears a hub connection down at the transport layer when the bearer
// token's lifetime expires, so a live connection can't outlive its JWT.
app.MapHub<ChatHub>("/api/hubs/chat", options => options.CloseOnAuthenticationExpiration = true);
app.MapGet("/", () => app.Environment.IsDevelopment()
    ? Results.Redirect("/swagger")
    : Results.Ok(new { service = "Usage IQ API" }));

app.Run();

// Exposed so integration tests can spin up the app via WebApplicationFactory<Program>.
public partial class Program { }
