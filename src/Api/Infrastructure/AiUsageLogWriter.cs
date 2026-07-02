using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// Drains <see cref="AiUsageLogQueue"/> off the AI path, batch-inserts entries, and prunes the table to a
/// recent window so it never grows unbounded. Mirrors <see cref="RequestLogWriter"/>.
/// </summary>
public sealed class AiUsageLogWriter(
    AiUsageLogQueue queue, IServiceScopeFactory scopeFactory, ILogger<AiUsageLogWriter> logger)
    : BackgroundService
{
    private const int BatchSize = 100;
    private const int MaxRows = 50_000;   // keep roughly this many most-recent rows
    private const int PruneEvery = 1_000; // rows inserted between prunes

    private int _sincePrune;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var reader = queue.Reader;
        var batch = new List<AiUsageLog>(BatchSize);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await reader.WaitToReadAsync(stoppingToken)) break;

                batch.Clear();
                while (batch.Count < BatchSize && reader.TryRead(out var item))
                    batch.Add(item);
                if (batch.Count == 0) continue;

                using var scope = scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
                db.AiUsageLogs.AddRange(batch);
                await db.SaveChangesAsync(stoppingToken);

                _sincePrune += batch.Count;
                if (_sincePrune >= PruneEvery)
                {
                    // Reset only AFTER a successful prune so a transient DB failure retries next batch
                    // rather than letting the table grow another full PruneEvery window unpruned.
                    await PruneAsync(db, stoppingToken);
                    _sincePrune = 0;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "AiUsageLogWriter failed to persist a batch; dropping it.");
                // Back off before retrying, but treat cancellation during shutdown as a clean exit
                // (the delay throws OperationCanceledException, which this generic catch would not).
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
    }

    private static async Task PruneAsync(UsageDbContext db, CancellationToken ct)
    {
        var newestId = await db.AiUsageLogs.MaxAsync(r => (long?)r.Id, ct) ?? 0;
        if (newestId > MaxRows)
            await db.AiUsageLogs.Where(r => r.Id <= newestId - MaxRows).ExecuteDeleteAsync(ct);
    }
}
