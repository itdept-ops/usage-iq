using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class ApiEndpoints
{
    public static void MapApiEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/health", () => Results.Ok(new { status = "ok" }));

        // ---- Sync ----
        api.MapPost("/sync", async (SyncCoordinator coordinator, CancellationToken ct) =>
            Results.Ok(await coordinator.TriggerAsync(waitIfBusy: true, ct)));

        api.MapGet("/sync/status", async (UsageDbContext db, SyncCoordinator coordinator, CancellationToken ct) =>
        {
            var s = await db.SyncStatuses.AsNoTracking().FirstOrDefaultAsync(ct);
            var cfg = await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
            return Results.Ok(new SyncStatusDto
            {
                LastSyncUtc = s?.LastSyncUtc,
                LastNewRecords = s?.LastNewRecords ?? 0,
                LastDurationMs = s?.LastDurationMs ?? 0,
                LastFilesParsed = s?.LastFilesParsed ?? 0,
                LastFilesScanned = s?.LastFilesScanned ?? 0,
                LastError = s?.LastError,
                IsRunning = coordinator.IsRunning,
                AutoSyncEnabled = cfg?.AutoSyncEnabled ?? true,
                IntervalSeconds = cfg?.AutoSyncIntervalSeconds ?? 300,
            });
        });

        // ---- Usage ----
        api.MapGet("/usage/summary", async (
            [AsParameters] UsageFilterQuery filter, string? groupBy, UsageQueries q, CancellationToken ct) =>
            Results.Ok(await q.SummaryAsync(filter, groupBy ?? "day", ct)));

        api.MapGet("/usage/records", async (
            [AsParameters] UsageFilterQuery filter,
            int? page, int? pageSize, string? sort, bool? desc,
            UsageQueries q, CancellationToken ct) =>
            Results.Ok(await q.RecordsAsync(filter, page ?? 1, pageSize ?? 50, sort ?? "timestamp", desc ?? true, ct)));

        // ---- Filter options ----
        api.MapGet("/projects", async (UsageQueries q, CancellationToken ct) =>
            Results.Ok(await q.ProjectsAsync(ct)));

        api.MapGet("/models", async (UsageQueries q, CancellationToken ct) =>
            Results.Ok(await q.ModelsAsync(ct)));

        // ---- Pricing ----
        api.MapGet("/pricing", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok(await db.ModelPricings.AsNoTracking()
                .OrderBy(p => p.ModelPattern == "*").ThenBy(p => p.ModelPattern)
                .Select(p => new PricingDto
                {
                    Id = p.Id, ModelPattern = p.ModelPattern, DisplayName = p.DisplayName,
                    InputPerMTok = p.InputPerMTok, OutputPerMTok = p.OutputPerMTok,
                    CacheWrite5mPerMTok = p.CacheWrite5mPerMTok, CacheWrite1hPerMTok = p.CacheWrite1hPerMTok,
                    CacheReadPerMTok = p.CacheReadPerMTok, IsPlaceholder = p.IsPlaceholder,
                }).ToListAsync(ct)));

        api.MapPut("/pricing/{id:int}", async (int id, PricingDto dto, UsageDbContext db, CancellationToken ct) =>
        {
            var row = await db.ModelPricings.FindAsync([id], ct);
            if (row is null) return Results.NotFound();
            row.DisplayName = dto.DisplayName;
            row.InputPerMTok = dto.InputPerMTok;
            row.OutputPerMTok = dto.OutputPerMTok;
            row.CacheWrite5mPerMTok = dto.CacheWrite5mPerMTok;
            row.CacheWrite1hPerMTok = dto.CacheWrite1hPerMTok;
            row.CacheReadPerMTok = dto.CacheReadPerMTok;
            row.IsPlaceholder = dto.IsPlaceholder;
            await db.SaveChangesAsync(ct);
            return Results.Ok(dto);
        });

        api.MapPost("/pricing", async (PricingDto dto, UsageDbContext db, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(dto.ModelPattern)) return Results.BadRequest("ModelPattern required");
            var row = new Data.Entities.ModelPricing
            {
                ModelPattern = dto.ModelPattern.Trim(), DisplayName = dto.DisplayName,
                InputPerMTok = dto.InputPerMTok, OutputPerMTok = dto.OutputPerMTok,
                CacheWrite5mPerMTok = dto.CacheWrite5mPerMTok, CacheWrite1hPerMTok = dto.CacheWrite1hPerMTok,
                CacheReadPerMTok = dto.CacheReadPerMTok, IsPlaceholder = dto.IsPlaceholder,
            };
            db.ModelPricings.Add(row);
            await db.SaveChangesAsync(ct);
            return Results.Created($"/api/pricing/{row.Id}", new { row.Id });
        });

        api.MapPost("/pricing/recompute", async (CostRecomputeService svc, CancellationToken ct) =>
            Results.Ok(await svc.RecomputeCostsAsync(ct)));

        // ---- Sources ----
        api.MapGet("/sources", async (UsageDbContext db, CancellationToken ct) =>
        {
            var counts = await db.UsageRecords.GroupBy(r => r.Source)
                .Select(g => new { Source = g.Key, Count = g.Count() })
                .ToDictionaryAsync(x => x.Source, x => x.Count, ct);
            var sources = await db.IngestionSources.AsNoTracking().OrderBy(s => s.Name).ToListAsync(ct);
            return Results.Ok(sources.Select(s => new SourceDto
            {
                Id = s.Id, Name = s.Name, Kind = s.Kind, RootPath = s.RootPath, Enabled = s.Enabled,
                Records = counts.GetValueOrDefault(s.Name),
            }));
        });

        api.MapPut("/sources/{id:int}", async (int id, SourceDto dto, UsageDbContext db, CancellationToken ct) =>
        {
            var s = await db.IngestionSources.FindAsync([id], ct);
            if (s is null) return Results.NotFound();
            s.RootPath = dto.RootPath?.Trim() ?? s.RootPath;
            s.Enabled = dto.Enabled;
            await db.SaveChangesAsync(ct);
            return Results.Ok(dto);
        });

        // ---- Settings ----
        api.MapGet("/settings", async (UsageDbContext db, CancellationToken ct) =>
        {
            var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
            return Results.Ok(new SettingsDto
            {
                DisplayTimeZone = cfg.DisplayTimeZone,
                ClaudeProjectsPath = cfg.ClaudeProjectsPath,
                AutoSyncEnabled = cfg.AutoSyncEnabled,
                AutoSyncIntervalSeconds = cfg.AutoSyncIntervalSeconds,
            });
        });

        api.MapPut("/settings", async (SettingsDto dto, UsageDbContext db, CostRecomputeService recompute, CancellationToken ct) =>
        {
            try { TimeZoneInfo.FindSystemTimeZoneById(dto.DisplayTimeZone); }
            catch { return Results.BadRequest($"Unknown timezone: {dto.DisplayTimeZone}"); }

            var cfg = await db.AppConfigs.FirstAsync(ct);
            var tzChanged = !string.Equals(cfg.DisplayTimeZone, dto.DisplayTimeZone, StringComparison.Ordinal);
            cfg.DisplayTimeZone = dto.DisplayTimeZone;
            cfg.ClaudeProjectsPath = dto.ClaudeProjectsPath;
            cfg.AutoSyncEnabled = dto.AutoSyncEnabled;
            cfg.AutoSyncIntervalSeconds = Math.Max(30, dto.AutoSyncIntervalSeconds);
            await db.SaveChangesAsync(ct);

            var rebucketed = 0;
            if (tzChanged) rebucketed = await recompute.RecomputeLocalDatesAsync(dto.DisplayTimeZone, ct);
            return Results.Ok(new { localDatesRebucketed = rebucketed });
        });
    }
}
