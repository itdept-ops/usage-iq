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

    if (!await db.AppConfigs.AnyAsync())
    {
        var path = builder.Configuration["Ingestion:ClaudeProjectsPath"];
        if (string.IsNullOrWhiteSpace(path))
            path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "projects");

        db.AppConfigs.Add(new AppConfig
        {
            Id = 1,
            DisplayTimeZone = builder.Configuration["Ingestion:DisplayTimeZone"] ?? "America/New_York",
            ClaudeProjectsPath = path,
        });
        await db.SaveChangesAsync();
    }
}

app.UseSwagger();
app.UseSwaggerUI();
app.UseCors();
app.MapApiEndpoints();
app.MapGet("/", () => Results.Redirect("/swagger"));

app.Run();
