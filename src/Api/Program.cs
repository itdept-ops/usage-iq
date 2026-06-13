using System.Text;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// Secrets (Google client id/secret, JWT signing key, email allowlist) live in this
// git-ignored file (baked into the Docker image at build time).
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

var conn = builder.Configuration.GetConnectionString("Default")
           ?? "Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password=ccusage_dev_pw";

builder.Services.AddDbContext<UsageDbContext>(o => o.UseNpgsql(conn));
builder.Services.AddScoped<JsonlIngestionService>();
builder.Services.AddScoped<CostRecomputeService>();
builder.Services.AddScoped<UsageQueries>();
builder.Services.AddScoped<GoogleAuthService>();
builder.Services.AddScoped<CurrentUserAccessor>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<SyncCoordinator>();
builder.Services.AddHostedService<AutoSyncBackgroundService>();

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

// Swagger (full API schema) is dev-only — don't expose the API surface to anonymous callers in prod.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.MapAuthEndpoints();
app.MapUsersEndpoints();
app.MapApiEndpoints();
app.MapGet("/", () => app.Environment.IsDevelopment()
    ? Results.Redirect("/swagger")
    : Results.Ok(new { service = "Usage IQ API" }));

app.Run();
