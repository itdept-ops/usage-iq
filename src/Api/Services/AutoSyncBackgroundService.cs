using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Background process that runs an incremental sync on a timer. Reads its enabled flag and
/// interval from <see cref="Data.Entities.AppConfig"/> on every cycle, so changes made in
/// Settings take effect without a restart. Skips a tick if a sync is already running.
/// </summary>
public sealed class AutoSyncBackgroundService(
    SyncCoordinator coordinator, IServiceScopeFactory scopeFactory, ILogger<AutoSyncBackgroundService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Auto-sync service started.");

        // Let the app/DB settle before the first run.
        try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            var (enabled, intervalSeconds) = await ReadConfigAsync(stoppingToken);

            if (enabled)
            {
                try
                {
                    var result = await coordinator.TriggerAsync(waitIfBusy: false, stoppingToken);
                    if (result is not null)
                        logger.LogInformation("Auto-sync added {New} rows in {Ms}ms.", result.NewRecords, result.DurationMs);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception ex) { logger.LogError(ex, "Auto-sync tick failed."); }
            }

            // When disabled, re-check every 30s so a re-enable is picked up promptly.
            var delaySeconds = enabled ? Math.Max(30, intervalSeconds) : 30;
            try { await Task.Delay(TimeSpan.FromSeconds(delaySeconds), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task<(bool Enabled, int IntervalSeconds)> ReadConfigAsync(CancellationToken ct)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var cfg = await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
            return cfg is null ? (true, 300) : (cfg.AutoSyncEnabled, cfg.AutoSyncIntervalSeconds);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to read auto-sync config; using defaults.");
            return (true, 300);
        }
    }
}
