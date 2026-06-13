using Ccusage.Api.Data;
using Ccusage.Api.Ingestion;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Re-derives denormalized values without re-reading any files: <see cref="RecomputeCostsAsync"/>
/// after a pricing edit, and <see cref="RecomputeLocalDatesAsync"/> after a timezone change.
/// </summary>
public sealed class CostRecomputeService(UsageDbContext db)
{
    public sealed record RecomputeResult(int ModelsUpdated, int RowsUpdated);

    public async Task<RecomputeResult> RecomputeCostsAsync(CancellationToken ct = default)
    {
        var pricing = new PricingMatcher(await db.ModelPricings.AsNoTracking().ToListAsync(ct));
        var models = await db.UsageRecords.Select(r => r.Model).Distinct().ToListAsync(ct);

        var rows = 0;
        foreach (var model in models)
        {
            var p = pricing.Resolve(model);
            decimal inR = p.InputPerMTok, outR = p.OutputPerMTok, readR = p.CacheReadPerMTok,
                    w5R = p.CacheWrite5mPerMTok, w1R = p.CacheWrite1hPerMTok;

            rows += await db.UsageRecords.Where(r => r.Model == model).ExecuteUpdateAsync(s => s
                .SetProperty(r => r.CostUsd,
                    r => (decimal)r.InputTokens / 1_000_000m * inR
                       + (decimal)r.OutputTokens / 1_000_000m * outR
                       + (decimal)r.CacheReadTokens / 1_000_000m * readR
                       + (decimal)r.CacheCreation5mTokens / 1_000_000m * w5R
                       + (decimal)r.CacheCreation1hTokens / 1_000_000m * w1R), ct);
        }
        return new RecomputeResult(models.Count, rows);
    }

    /// <summary>Re-bucket every record's local date using a new timezone (Postgres AT TIME ZONE).</summary>
    public async Task<int> RecomputeLocalDatesAsync(string ianaTimeZone, CancellationToken ct = default) =>
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "UsageRecords" SET "LocalDate" = ("TimestampUtc" AT TIME ZONE {ianaTimeZone})::date""", ct);
}
