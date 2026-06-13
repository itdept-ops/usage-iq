using Ccusage.Api.Data;
using Ccusage.Api.Ingestion;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Singleton that serializes sync runs (manual + background timer never overlap) and
/// persists the result to the single <see cref="Data.Entities.SyncStatus"/> row.
/// </summary>
public sealed class SyncCoordinator(IServiceScopeFactory scopeFactory, ILogger<SyncCoordinator> logger)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public bool IsRunning => _gate.CurrentCount == 0;

    /// <summary>
    /// Run a sync. If one is already in progress: when <paramref name="waitIfBusy"/> is true the
    /// call awaits its turn and then runs; when false it returns <c>null</c> (used by the timer).
    /// </summary>
    public async Task<SyncResult?> TriggerAsync(bool waitIfBusy, CancellationToken ct = default)
    {
        if (waitIfBusy)
            await _gate.WaitAsync(ct);
        else if (!await _gate.WaitAsync(0, ct))
            return null;

        try
        {
            using var scope = scopeFactory.CreateScope();
            var ingestion = scope.ServiceProvider.GetRequiredService<JsonlIngestionService>();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();

            var result = await ingestion.SyncAsync(ct);

            await db.SyncStatuses.Where(s => s.Id == 1).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.LastSyncUtc, DateTime.UtcNow)
                .SetProperty(x => x.LastNewRecords, result.NewRecords)
                .SetProperty(x => x.LastDurationMs, result.DurationMs)
                .SetProperty(x => x.LastFilesParsed, result.FilesParsed)
                .SetProperty(x => x.LastFilesScanned, result.FilesScanned)
                .SetProperty(x => x.LastError, result.Error), ct);

            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
}
