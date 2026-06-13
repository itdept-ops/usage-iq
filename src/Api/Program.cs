using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var conn = builder.Configuration.GetConnectionString("Default")
           ?? "Host=localhost;Port=5433;Database=ccusage;Username=ccusage;Password=ccusage_dev_pw";

builder.Services.AddDbContext<UsageDbContext>(o => o.UseNpgsql(conn));
builder.Services.AddScoped<JsonlIngestionService>();
builder.Services.AddScoped<CostRecomputeService>();
builder.Services.AddScoped<UsageQueries>();
builder.Services.AddSingleton<SyncCoordinator>();
builder.Services.AddHostedService<AutoSyncBackgroundService>();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var corsOrigin = builder.Configuration["Cors:AllowedOrigin"] ?? "http://localhost:4200";
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(corsOrigin).AllowAnyHeader().AllowAnyMethod()));

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
}

app.UseSwagger();
app.UseSwaggerUI();
app.UseCors();
app.MapApiEndpoints();
app.MapGet("/", () => Results.Redirect("/swagger"));

app.Run();
