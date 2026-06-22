using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Background pass that fills in IP-geolocation (coarse city/region/country + centroid lat/lng) for
/// <see cref="Data.Entities.MachineInfo"/> rows. Desktops have no GPS, so a machine's "fleet location" is
/// the IP-geo of its server-observed <c>PublicIp</c>. Doing this off the ingest hot path keeps ingest fast
/// and respects the keyless ip-api rate limit (the lookups are also cached + throttled in the service).
///
/// Each pass picks a small batch of rows that have a <c>PublicIp</c> but either have never been geo-resolved
/// (<c>GeoUpdatedUtc is null</c>) or whose resolution is stale (older than <see cref="StaleAfter"/>), and
/// resolves them via <see cref="IpGeoService"/> (graceful-null). Every row attempted gets <c>GeoUpdatedUtc</c>
/// stamped — even on a null result — so a private/unresolvable IP isn't retried every pass. Best-effort:
/// a failure never throws out of the loop.
/// </summary>
public sealed class MachineGeoBackfillService(
    IServiceScopeFactory scopeFactory, ILogger<MachineGeoBackfillService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    /// <summary>Re-resolve a machine's IP-geo at most this often (the PublicIp rarely changes).</summary>
    private static readonly TimeSpan StaleAfter = TimeSpan.FromDays(7);
    private const int BatchSize = 20;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Run once shortly after startup, then on the interval.
        try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
                var ipGeo = scope.ServiceProvider.GetRequiredService<IpGeoService>();
                await RunOnceAsync(db, ipGeo, DateTime.UtcNow, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning(ex, "Machine IP-geo backfill pass failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>
    /// One pass: resolve IP-geo for up to <see cref="BatchSize"/> machines needing it as of
    /// <paramref name="now"/>. Public + parameterized so a test can drive a single deterministic cycle.
    /// Returns how many rows were updated.
    /// </summary>
    public async Task<int> RunOnceAsync(UsageDbContext db, IpGeoService ipGeo, DateTime now, CancellationToken ct = default)
    {
        var staleBefore = now - StaleAfter;
        var candidates = await db.MachineInfos
            .Where(m => m.PublicIp != null && m.PublicIp != ""
                        && (m.GeoUpdatedUtc == null || m.GeoUpdatedUtc < staleBefore))
            .OrderBy(m => m.GeoUpdatedUtc) // nulls first, then oldest
            .Take(BatchSize)
            .ToListAsync(ct);

        var updated = 0;
        foreach (var m in candidates)
        {
            var geo = await ipGeo.LookupAsync(m.PublicIp, ct); // graceful-null, never throws

            // Stamp the attempt either way so an unresolvable IP isn't retried every pass; on a hit, fill geo.
            if (geo is not null)
            {
                m.City = geo.City;
                m.Region = geo.Region;
                m.Country = geo.Country;
                m.Lat = geo.Lat;
                m.Lng = geo.Lng;
            }
            m.GeoUpdatedUtc = now;
            updated++;
        }

        if (updated > 0) await db.SaveChangesAsync(ct);
        return updated;
    }
}
