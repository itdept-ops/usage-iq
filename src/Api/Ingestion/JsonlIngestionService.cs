using System.Diagnostics;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Walks every enabled <see cref="IngestionSource"/>, delegates per-file parsing to the
/// matching <see cref="ISourceParser"/>, keeps one row per <see cref="ParsedUsage.DedupKey"/>,
/// prices it, and stores it. Unchanged files (same size + mtime) are skipped; changed files
/// are reparsed and de-dup makes re-ingestion idempotent.
/// </summary>
public sealed class JsonlIngestionService(UsageDbContext db, ILogger<JsonlIngestionService> logger)
{
    private const int BatchSize = 2000;

    private static readonly string[] SkipSegments = [@"\.tmp\", @"\node_modules\", "plugins-backup"];

    private readonly Dictionary<string, ISourceParser> _parsers =
        new[] { (ISourceParser)new ClaudeParser(), new CodexParser(), new GeminiParser() }
            .ToDictionary(p => p.Kind, StringComparer.OrdinalIgnoreCase);

    public async Task<SyncResult> SyncAsync(CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
        var result = new SyncResult { TimeZone = cfg.DisplayTimeZone };

        var tz = ResolveTimeZone(cfg.DisplayTimeZone, result);
        var pricing = new PricingMatcher(await db.ModelPricings.AsNoTracking().ToListAsync(ct));

        var seen = new HashSet<string>(
            await db.UsageRecords.Select(r => r.DedupKey).ToListAsync(ct), StringComparer.Ordinal);
        var projectIdByRoot = (await db.Projects.AsNoTracking().ToListAsync(ct))
            .ToDictionary(p => p.RepoRoot, p => p.Id, StringComparer.OrdinalIgnoreCase);
        var fileByPath = (await db.IngestedFiles.AsNoTracking().ToListAsync(ct))
            .ToDictionary(f => f.Path, StringComparer.OrdinalIgnoreCase);

        db.ChangeTracker.AutoDetectChangesEnabled = false;

        var sources = await db.IngestionSources.AsNoTracking().Where(s => s.Enabled).ToListAsync(ct);
        var pending = new List<UsageRecord>(BatchSize);

        foreach (var source in sources)
        {
            if (!_parsers.TryGetValue(source.Kind, out var parser))
            {
                logger.LogWarning("No parser for source kind '{Kind}'", source.Kind);
                continue;
            }
            if (!Directory.Exists(source.RootPath))
            {
                result.SourceWarnings.Add($"{source.Name}: path not found ({source.RootPath})");
                continue;
            }

            foreach (var path in Directory.EnumerateFiles(source.RootPath, "*.jsonl", SearchOption.AllDirectories))
            {
                ct.ThrowIfCancellationRequested();
                if (ShouldSkip(path) || !parser.MatchesFile(Path.GetFileName(path))) continue;

                result.FilesScanned++;

                FileInfo info;
                try { info = new FileInfo(path); }
                catch (Exception ex) { logger.LogWarning(ex, "stat failed: {Path}", path); continue; }

                var size = info.Length;
                var mtime = info.LastWriteTimeUtc;

                if (fileByPath.TryGetValue(path, out var tracked)
                    && tracked.SizeBytes == size
                    && Math.Abs((tracked.LastModifiedUtc - mtime).TotalSeconds) < 2)
                {
                    result.FilesSkipped++;
                    continue;
                }

                result.FilesParsed++;

                if (tracked is null)
                {
                    tracked = new IngestedFile { Path = path, LastSyncUtc = DateTime.UtcNow };
                    db.IngestedFiles.Add(tracked);
                    await db.SaveChangesAsync(ct);
                    db.ChangeTracker.Clear();
                    fileByPath[path] = tracked;
                }

                var rows = await ProcessFileAsync(path, source, parser, tracked.Id, tz, pricing,
                    seen, projectIdByRoot, pending, result, ct);

                await db.IngestedFiles.Where(f => f.Id == tracked.Id).ExecuteUpdateAsync(s => s
                    .SetProperty(f => f.SizeBytes, size)
                    .SetProperty(f => f.LastModifiedUtc, mtime)
                    .SetProperty(f => f.LinesIngested, rows)
                    .SetProperty(f => f.LastSyncUtc, DateTime.UtcNow), ct);
            }
        }

        await FlushAsync(pending, result, ct);

        result.UnpricedModels = pricing.UnpricedModels.OrderBy(m => m).ToList();
        result.DurationMs = sw.ElapsedMilliseconds;
        logger.LogInformation("Sync done: {New} new rows from {Parsed}/{Scanned} files in {Ms}ms",
            result.NewRecords, result.FilesParsed, result.FilesScanned, result.DurationMs);
        return result;
    }

    private async Task<int> ProcessFileAsync(
        string path, IngestionSource source, ISourceParser parser, int fileId, TimeZoneInfo tz,
        PricingMatcher pricing, HashSet<string> seen, Dictionary<string, int> projectIdByRoot,
        List<UsageRecord> pending, SyncResult result, CancellationToken ct)
    {
        var rows = 0;
        var fileName = Path.GetFileName(path);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);

        foreach (var pu in parser.Parse(reader, fileName))
        {
            rows++;
            if (!seen.Add(pu.DedupKey)) continue;

            var cwd = pu.Cwd ?? "(unknown)";
            var (repoRoot, name) = ProjectResolver.Resolve(cwd);
            if (!projectIdByRoot.TryGetValue(repoRoot, out var projectId))
            {
                var proj = new Project { RepoRoot = repoRoot, Name = name, FolderName = ProjectResolver.TopFolder(path, source.RootPath) };
                db.Projects.Add(proj);
                await db.SaveChangesAsync(ct);
                db.ChangeTracker.Clear();
                projectId = proj.Id;
                projectIdByRoot[repoRoot] = projectId;
            }

            pending.Add(UsageRecordMapper.Map(pu, source.Name, cwd, projectId, fileId, tz, pricing));
            result.NewRecordsBySource[source.Name] = result.NewRecordsBySource.GetValueOrDefault(source.Name) + 1;

            if (pending.Count >= BatchSize) await FlushAsync(pending, result, ct);
        }

        return rows;
    }

    private async Task FlushAsync(List<UsageRecord> pending, SyncResult result, CancellationToken ct)
    {
        if (pending.Count == 0) return;
        db.UsageRecords.AddRange(pending);
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
        result.NewRecords += pending.Count;
        pending.Clear();
    }

    private static bool ShouldSkip(string path) =>
        SkipSegments.Any(seg => path.Contains(seg, StringComparison.OrdinalIgnoreCase));

    private TimeZoneInfo ResolveTimeZone(string id, SyncResult result)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Unknown timezone '{Tz}', falling back to local", id);
            result.Warning = $"Unknown timezone '{id}'; used system local time instead.";
            return TimeZoneInfo.Local;
        }
    }
}
