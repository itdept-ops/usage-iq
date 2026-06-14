using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// Drains <see cref="RequestLogQueue"/> off the request path, batch-inserts entries, and prunes the
/// table to a recent window so it never grows unbounded.
/// </summary>
public sealed class RequestLogWriter(
    RequestLogQueue queue, IServiceScopeFactory scopeFactory, ILogger<RequestLogWriter> logger)
    : BackgroundService
{
    private const int BatchSize = 100;
    private const int MaxRows = 10_000;   // keep roughly this many most-recent rows
    private const int PruneEvery = 1_000; // rows inserted between prunes

    private int _sincePrune;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var reader = queue.Reader;
        var batch = new List<RequestLog>(BatchSize);

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
                db.RequestLogs.AddRange(batch);
                await db.SaveChangesAsync(stoppingToken);

                _sincePrune += batch.Count;
                if (_sincePrune >= PruneEvery)
                {
                    _sincePrune = 0;
                    await PruneAsync(db, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "RequestLogWriter failed to persist a batch; dropping it.");
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
            }
        }
    }

    private static async Task PruneAsync(UsageDbContext db, CancellationToken ct)
    {
        var newestId = await db.RequestLogs.MaxAsync(r => (long?)r.Id, ct) ?? 0;
        if (newestId > MaxRows)
            await db.RequestLogs.Where(r => r.Id <= newestId - MaxRows).ExecuteDeleteAsync(ct);
    }
}
