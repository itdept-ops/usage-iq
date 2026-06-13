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
        api.MapPost("/sync", async (JsonlIngestionService svc, CancellationToken ct) =>
            Results.Ok(await svc.SyncAsync(ct)));

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

        // ---- Settings ----
        api.MapGet("/settings", async (UsageDbContext db, CancellationToken ct) =>
        {
            var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
            return Results.Ok(new SettingsDto { DisplayTimeZone = cfg.DisplayTimeZone, ClaudeProjectsPath = cfg.ClaudeProjectsPath });
        });

        api.MapPut("/settings", async (SettingsDto dto, UsageDbContext db, CostRecomputeService recompute, CancellationToken ct) =>
        {
            try { TimeZoneInfo.FindSystemTimeZoneById(dto.DisplayTimeZone); }
            catch { return Results.BadRequest($"Unknown timezone: {dto.DisplayTimeZone}"); }

            var cfg = await db.AppConfigs.FirstAsync(ct);
            var tzChanged = !string.Equals(cfg.DisplayTimeZone, dto.DisplayTimeZone, StringComparison.Ordinal);
            cfg.DisplayTimeZone = dto.DisplayTimeZone;
            cfg.ClaudeProjectsPath = dto.ClaudeProjectsPath;
            await db.SaveChangesAsync(ct);

            var rebucketed = 0;
            if (tzChanged) rebucketed = await recompute.RecomputeLocalDatesAsync(dto.DisplayTimeZone, ct);
            return Results.Ok(new { dto.DisplayTimeZone, dto.ClaudeProjectsPath, localDatesRebucketed = rebucketed });
        });
    }
}
