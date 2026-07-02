using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// PUBLIC, anonymous, marketing-only endpoints. Today: the "Built With Usage IQ" badge
/// (<c>GET /api/public/built-with</c>) that powers the live counter band on the Aurora landing page.
///
/// DISCIPLINE (mirrors <see cref="ShareEndpoints"/>' public read):
/// <list type="bullet">
///   <item>AllowAnonymous + RequireRateLimiting("share") — no auth, abuse-bounded.</item>
///   <item>NUMBERS ONLY — aggregate counts/cost for the single OWNER account. NEVER an email, name, project,
///   or model list, so there is no PII to leak and the response is identical for every caller.</item>
///   <item>CACHE-SAFE — the payload never varies by user, so a short shared cache (Cache-Control public,
///   max-age) is correct; we set it on the response so a CDN/browser can hold it ~10 minutes.</item>
/// </list>
/// </summary>
public static class PublicEndpoints
{
    /// <summary>The shared cache window for the badge (seconds). The figures move slowly (all-time totals),
    /// so a ~10-minute public cache is plenty fresh and shields the DB from a hot marketing page.</summary>
    private const int CacheSeconds = 600;

    public static void MapPublicEndpoints(this WebApplication app)
    {
        // ---- GET /api/public/built-with : the anonymous, cacheable marketing badge ----
        app.MapGet("/api/public/built-with", async (
            HttpContext http, IConfiguration config, UsageDbContext db, UsageQueries q,
            IMemoryCache cache, CancellationToken ct) =>
        {
            // Resolve the OWNER deterministically:
            //  1) the first configured admin email (Auth:AdminEmails[0]) — the canonical site owner; else
            //  2) the lowest-Id user holding users.manage (the earliest-provisioned administrator).
            // DOCUMENTED choice: AdminEmails[0] is the break-glass site owner in this app (Program.cs seeds it
            // with every permission), so it is the natural "whose usage powers the badge" identity; the
            // users.manage fallback keeps the badge working on an instance configured purely via the DB.
            var ownerEmail = await ResolveOwnerEmailAsync(config, db, ct);
            if (ownerEmail is null)
                return Results.Ok(Empty()); // no owner yet (fresh install) — a zeroed, still-cacheable badge.

            // SERVER-SIDE CACHE (the real DoS shield): the header cache is advisory — a CDN/browser MAY hold
            // it, but an anonymous caller varying headers, or any CDN miss, would otherwise force a fresh
            // row-materializing StatsAsync over the owner's (largest) lifetime dataset on every hit. Cache the
            // fully-computed, caller-invariant DTO in-process keyed on the owner for the same ~10-minute window,
            // so anonymous callers hit an in-memory value instead of the database.
            var cacheKey = $"public:built-with:{ownerEmail}";
            var dto = await cache.GetOrCreateAsync(cacheKey, async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(CacheSeconds);

                // All-time, OWNER-SCOPED usage (ReportedByUser == owner). No date/project/model/source filter,
                // so these are the owner's lifetime totals. The attribution filter keys on the RAW
                // ReportedByUser value, which is the lower-cased owner email — never serialized; only the
                // aggregate numbers leave.
                var filter = new UsageFilterQuery(
                    from: null, to: null, projectId: null, model: null, source: null, includeSidechain: null,
                    machine: null, user: new[] { ownerEmail });

                var summary = await q.SummaryAsync(filter, "day", ct);   // Total.TotalTokens + Total.CostUsd
                var fleet = await q.FleetAsync(filter, ct);              // distinct machines = agents
                var stats = await q.StatsAsync(filter, idleGapMinutes: 30, ct); // sessions + active days

                return new PublicBuiltWithDto
                {
                    TotalTokens = summary.Total.TotalTokens,
                    TotalCostUsd = summary.Total.CostUsd,
                    AgentCount = fleet.Machines.Count,
                    SessionCount = stats.TotalSessions,
                    ActiveDays = stats.ActiveDays,
                    GeneratedAtUtc = DateTime.UtcNow,
                    AsOf = "all time",
                };
            });

            // Cache-safe: the payload never varies by caller, so advertise a short shared cache window.
            http.Response.Headers.CacheControl = $"public, max-age={CacheSeconds}";
            return Results.Ok(dto);
        }).AllowAnonymous().RequireRateLimiting("share");
    }

    /// <summary>A zeroed badge (no owner / no usage yet) — still aggregate-only and cacheable.</summary>
    private static PublicBuiltWithDto Empty() => new()
    {
        TotalTokens = 0, TotalCostUsd = 0m, AgentCount = 0, SessionCount = 0, ActiveDays = 0,
        GeneratedAtUtc = DateTime.UtcNow, AsOf = "all time",
    };

    /// <summary>
    /// The deterministic OWNER email: the first configured admin (Auth:AdminEmails[0]), else the lowest-Id
    /// users.manage holder. Returns null only on a fresh install with neither configured nor seeded.
    /// </summary>
    private static async Task<string?> ResolveOwnerEmailAsync(
        IConfiguration config, UsageDbContext db, CancellationToken ct)
    {
        var configured = (config.GetSection("Auth:AdminEmails").Get<string[]>() ?? Array.Empty<string>())
            .Select(e => e.Trim().ToLowerInvariant())
            .FirstOrDefault(e => e.Length > 0);
        if (configured is not null) return configured;

        return await db.Users.AsNoTracking()
            .Where(u => u.Permissions.Any(p => p.Permission == Auth.Permissions.UsersManage))
            .OrderBy(u => u.Id)
            .Select(u => u.Email)
            .FirstOrDefaultAsync(ct);
    }
}
