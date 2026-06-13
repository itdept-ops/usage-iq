using System.Diagnostics;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Walks the Claude Code projects directory, parses every <c>*.jsonl</c> transcript,
/// keeps one row per <c>(message.id, requestId)</c>, prices it, and stores it. Unchanged
/// files (same size + mtime) are skipped; changed files are reparsed and de-dup makes
/// re-ingestion idempotent.
/// </summary>
public sealed class JsonlIngestionService(UsageDbContext db, ILogger<JsonlIngestionService> logger)
{
    private const int BatchSize = 2000;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
    };

    public async Task<SyncResult> SyncAsync(CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
        var result = new SyncResult { ProjectsPath = cfg.ClaudeProjectsPath, TimeZone = cfg.DisplayTimeZone };

        if (!Directory.Exists(cfg.ClaudeProjectsPath))
        {
            result.Error = $"Claude projects path not found: {cfg.ClaudeProjectsPath}";
            result.DurationMs = sw.ElapsedMilliseconds;
            return result;
        }

        var tz = ResolveTimeZone(cfg.DisplayTimeZone, result);
        var pricing = new PricingMatcher(await db.ModelPricings.AsNoTracking().ToListAsync(ct));

        // All de-dup keys already stored (so re-syncing a changed file inserts nothing twice).
        var seen = new HashSet<string>(
            await db.UsageRecords.Select(r => r.DedupKey).ToListAsync(ct), StringComparer.Ordinal);

        var projectIdByRoot = (await db.Projects.AsNoTracking().ToListAsync(ct))
            .ToDictionary(p => p.RepoRoot, p => p.Id, StringComparer.OrdinalIgnoreCase);
        var fileByPath = (await db.IngestedFiles.AsNoTracking().ToListAsync(ct))
            .ToDictionary(f => f.Path, StringComparer.OrdinalIgnoreCase);

        db.ChangeTracker.AutoDetectChangesEnabled = false;

        var pending = new List<UsageRecord>(BatchSize);

        foreach (var path in Directory.EnumerateFiles(cfg.ClaudeProjectsPath, "*.jsonl", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
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

            // Ensure a row exists so we have an Id for the FK.
            if (tracked is null)
            {
                tracked = new IngestedFile { Path = path, LastSyncUtc = DateTime.UtcNow };
                db.IngestedFiles.Add(tracked);
                await db.SaveChangesAsync(ct);
                db.ChangeTracker.Clear();
                fileByPath[path] = tracked;
            }

            var lines = await ParseFileAsync(path, tracked.Id, tz, pricing, seen, projectIdByRoot,
                cfg.ClaudeProjectsPath, pending, result, ct);

            // Persist updated file watermark (direct SQL — no tracking needed).
            await db.IngestedFiles.Where(f => f.Id == tracked.Id).ExecuteUpdateAsync(s => s
                .SetProperty(f => f.SizeBytes, size)
                .SetProperty(f => f.LastModifiedUtc, mtime)
                .SetProperty(f => f.LinesIngested, lines)
                .SetProperty(f => f.LastSyncUtc, DateTime.UtcNow), ct);

            result.TotalLines += lines;
        }

        await FlushAsync(pending, result, ct);

        result.UnpricedModels = pricing.UnpricedModels.OrderBy(m => m).ToList();
        result.DurationMs = sw.ElapsedMilliseconds;
        logger.LogInformation("Sync done: {New} new rows from {Parsed}/{Scanned} files in {Ms}ms",
            result.NewRecords, result.FilesParsed, result.FilesScanned, result.DurationMs);
        return result;
    }

    private async Task<int> ParseFileAsync(
        string path, int fileId, TimeZoneInfo tz, PricingMatcher pricing, HashSet<string> seen,
        Dictionary<string, int> projectIdByRoot, string root, List<UsageRecord> pending,
        SyncResult result, CancellationToken ct)
    {
        var lines = 0;
        // FileShare.ReadWrite so we can read the live session file being appended to.
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);

        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            lines++;
            if (line.Length == 0) continue;

            JsonlLine? rec;
            try { rec = JsonSerializer.Deserialize<JsonlLine>(line, JsonOpts); }
            catch { result.MalformedLines++; continue; }

            var msg = rec?.Message;
            var usage = msg?.Usage;
            if (rec?.Type != "assistant" || usage is null || string.IsNullOrEmpty(msg!.Id))
                continue;

            var dedup = msg.Id + "|" + (rec.RequestId ?? "");
            if (!seen.Add(dedup)) continue; // already stored or seen this run

            var input = ToInt(usage.InputTokens);
            var output = ToInt(usage.OutputTokens);
            var read = usage.CacheReadInputTokens ?? 0;
            var write5m = usage.CacheCreation?.Ephemeral5m ?? 0;
            var write1h = usage.CacheCreation?.Ephemeral1h ?? 0;
            if (usage.CacheCreation is null && usage.CacheCreationInputTokens is { } flat)
                write5m = flat; // older shape: treat the flat field as 5m writes

            var cwd = rec.Cwd ?? "(unknown)";
            var (repoRoot, name) = ProjectResolver.Resolve(cwd);
            if (!projectIdByRoot.TryGetValue(repoRoot, out var projectId))
            {
                var proj = new Project { RepoRoot = repoRoot, Name = name, FolderName = ProjectResolver.TopFolder(path, root) };
                db.Projects.Add(proj);
                await db.SaveChangesAsync(ct);
                db.ChangeTracker.Clear();
                projectId = proj.Id;
                projectIdByRoot[repoRoot] = projectId;
            }

            var tsUtc = (rec.Timestamp ?? DateTimeOffset.UnixEpoch).UtcDateTime;
            var model = string.IsNullOrEmpty(msg.Model) ? "(unknown)" : msg.Model!;

            pending.Add(new UsageRecord
            {
                MessageId = msg.Id!,
                RequestId = rec.RequestId,
                DedupKey = dedup,
                TimestampUtc = DateTime.SpecifyKind(tsUtc, DateTimeKind.Utc),
                LocalDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(tsUtc, tz)),
                Model = model,
                InputTokens = input,
                OutputTokens = output,
                CacheReadTokens = read,
                CacheCreation5mTokens = ToInt(write5m),
                CacheCreation1hTokens = ToInt(write1h),
                SessionId = rec.SessionId ?? "",
                ProjectId = projectId,
                Cwd = cwd,
                GitBranch = rec.GitBranch,
                IsSidechain = rec.IsSidechain ?? false,
                AgentId = rec.AgentId,
                Version = rec.Version,
                CostUsd = pricing.Cost(model, input, output, read, write5m, write1h),
                IngestedFileId = fileId,
            });

            if (pending.Count >= BatchSize) await FlushAsync(pending, result, ct);
        }

        return lines;
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

    private static int ToInt(long? v) => v is null ? 0 : (int)Math.Clamp(v.Value, 0, int.MaxValue);

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
