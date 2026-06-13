namespace Ccusage.Api.Services;

/// <summary>
/// Background process that runs an incremental sync on a timer. Syncs once shortly after
/// startup, then every <c>AutoSync:IntervalSeconds</c>. Skips a tick if a sync is already
/// running (manual or a slow previous tick).
/// </summary>
public sealed class AutoSyncBackgroundService(
    SyncCoordinator coordinator, IConfiguration config, ILogger<AutoSyncBackgroundService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("AutoSync:Enabled", true))
        {
            logger.LogInformation("Auto-sync is disabled (AutoSync:Enabled=false).");
            return;
        }

        var intervalSeconds = Math.Max(30, config.GetValue("AutoSync:IntervalSeconds", 300));
        logger.LogInformation("Auto-sync enabled: every {Seconds}s.", intervalSeconds);

        // Let the app/DB settle before the first run.
        try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(intervalSeconds));
        do
        {
            try
            {
                var result = await coordinator.TriggerAsync(waitIfBusy: false, stoppingToken);
                if (result is null)
                    logger.LogDebug("Auto-sync tick skipped (a sync is already running).");
                else
                    logger.LogInformation("Auto-sync added {New} rows in {Ms}ms.", result.NewRecords, result.DurationMs);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Auto-sync tick failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
