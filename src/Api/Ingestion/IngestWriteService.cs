using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Server-side write path for usage rows pushed by a remote reporter (<c>POST /api/ingest</c>).
/// The reporter sends only parsed, source-neutral <see cref="ParsedUsage"/> rows; this service does
/// everything sensitive/authoritative on the server: validates + clamps the untrusted payload,
/// resolves the project from <c>cwd</c>, prices each row from the editable pricing table, de-dupes
/// against the unique <see cref="UsageRecord.DedupKey"/>, and persists. Unknown source kinds are
/// rejected so a caller can't inject an arbitrary <see cref="UsageRecord.Source"/> label.
/// </summary>
public sealed class IngestWriteService(UsageDbContext db, ILogger<IngestWriteService> logger)
{
    /// <summary>Hard cap on rows per request (the reporter chunks well below this).</summary>
    public const int MaxRowsPerBatch = 5000;

    // Only kinds we have a parser + pricing story for. Maps the reporter's parser kind to the
    // canonical Source label the local sync also uses, so remote rows merge with local ones.
    private static readonly Dictionary<string, string> KindToSource = new(StringComparer.OrdinalIgnoreCase)
    {
        ["claude"] = "claude-code",
        ["codex"] = "codex",
    };

    public static bool IsKnownSource(string? kind) => kind is not null && KindToSource.ContainsKey(kind);

    public async Task<IngestResultDto> WriteAsync(
        string sourceKind, string? machine, IReadOnlyList<ParsedUsage> rows, CancellationToken ct)
    {
        var source = KindToSource[sourceKind]; // caller validated via IsKnownSource

        var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
        var tz = ResolveTimeZone(cfg.DisplayTimeZone);
        var pricing = new PricingMatcher(await db.ModelPricings.AsNoTracking().ToListAsync(ct));

        var fileId = await GetOrCreateRemoteFileAsync(machine, source, ct);

        var projectIdByRoot = (await db.Projects.AsNoTracking().ToListAsync(ct))
            .ToDictionary(p => p.RepoRoot, p => p.Id, StringComparer.OrdinalIgnoreCase);

        // Sanitize + within-batch de-dup the untrusted payload first.
        var batch = new Dictionary<string, ParsedUsage>(StringComparer.Ordinal);
        foreach (var raw in rows)
        {
            var clean = Sanitize(raw);
            if (clean is null) continue;            // malformed → skip, don't 500 the batch
            batch[clean.DedupKey] = clean;          // last write wins for dup keys in the same payload
        }

        var result = new IngestResultDto { Received = rows.Count };
        if (batch.Count == 0)
        {
            result.UnpricedModels = Array.Empty<string>();
            return result;
        }

        // Which of these keys already exist? Bounded IN-list, index-backed.
        var keys = batch.Keys.ToList();
        var existing = (await db.UsageRecords.AsNoTracking()
                .Where(r => keys.Contains(r.DedupKey))
                .Select(r => r.DedupKey).ToListAsync(ct))
            .ToHashSet(StringComparer.Ordinal);

        var pending = new List<UsageRecord>(batch.Count);
        foreach (var pu in batch.Values)
        {
            if (existing.Contains(pu.DedupKey)) continue;

            var cwd = pu.Cwd ?? "(unknown)";
            var projectId = await GetOrCreateProjectAsync(cwd, projectIdByRoot, ct);
            pending.Add(UsageRecordMapper.Map(pu, source, cwd, projectId, fileId, tz, pricing));
        }

        var (inserted, insertedTokens) = await InsertNewAsync(pending, ct);

        if (inserted > 0)
            await db.IngestedFiles.Where(f => f.Id == fileId).ExecuteUpdateAsync(s => s
                .SetProperty(f => f.LinesIngested, f => f.LinesIngested + inserted)
                .SetProperty(f => f.LastSyncUtc, _ => DateTime.UtcNow), ct);

        result.Inserted = inserted;
        result.InsertedTokens = insertedTokens;                      // combined tokens of the new rows
        result.Duplicates = existing.Count;                          // valid keys already in the DB
        result.Skipped = Math.Max(0, result.Received - inserted - existing.Count); // malformed + within-batch + DB-rejected
        result.UnpricedModels = pricing.UnpricedModels.OrderBy(m => m).ToArray();
        logger.LogInformation("Ingest from '{Machine}' ({Source}): {Inserted} new, {Dup} dup, {Skip} skipped of {Received}",
            machine ?? "unknown", source, inserted, result.Duplicates, result.Skipped, result.Received);

        // Reflect this push in the dashboard's "Synced X ago" indicator — when the API is hosted in the
        // cloud there's no local file sync to drive it, so the remote reporter is the sync. Best-effort.
        try
        {
            var now = DateTime.UtcNow;
            await db.SyncStatuses.Where(x => x.Id == 1).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.LastSyncUtc, now)
                .SetProperty(x => x.LastNewRecords, inserted)
                .SetProperty(x => x.LastError, (string?)null), ct);
        }
        catch (Exception ex) { logger.LogWarning(ex, "Failed to update sync status after ingest."); }

        return result;
    }

    /// <summary>
    /// Insert the new rows. On a unique-key race, re-filter against the DB and retry the remainder
    /// (bounded loop — concurrent inserters converge instead of bubbling a 500). On any other write
    /// error (e.g. a single value that won't fit a column), fall back to per-row inserts so one bad
    /// row can never poison the whole batch.
    /// </summary>
    private async Task<(int Count, long Tokens)> InsertNewAsync(List<UsageRecord> pending, CancellationToken ct)
    {
        if (pending.Count == 0) return (0, 0);
        var remaining = pending;

        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                db.UsageRecords.AddRange(remaining);
                await db.SaveChangesAsync(ct);
                return (remaining.Count, remaining.Sum(TokensOf));   // AddRange+SaveChanges is atomic
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex) && attempt < 3)
            {
                // A concurrent ingest inserted some of these between our existence check and save.
                db.ChangeTracker.Clear();
                logger.LogWarning(ex, "Ingest insert hit a unique conflict; retrying the remainder (attempt {Attempt}).", attempt);
                var keys = remaining.Select(p => p.DedupKey).ToList();
                var now = (await db.UsageRecords.AsNoTracking()
                        .Where(r => keys.Contains(r.DedupKey)).Select(r => r.DedupKey).ToListAsync(ct))
                    .ToHashSet(StringComparer.Ordinal);
                remaining = remaining.Where(p => !now.Contains(p.DedupKey)).ToList();
                if (remaining.Count == 0) return (0, 0);
            }
            catch (DbUpdateException ex)
            {
                // Non-unique failure (or exhausted unique retries): isolate the offending row(s) so
                // the rest of the batch still lands.
                db.ChangeTracker.Clear();
                logger.LogWarning(ex, "Ingest bulk insert failed; isolating rows individually.");
                return await InsertPerRowAsync(remaining, ct);
            }
        }
        return await InsertPerRowAsync(remaining, ct);
    }

    /// <summary>Last-resort insert: one row per SaveChanges, dropping any row the DB rejects.</summary>
    private async Task<(int Count, long Tokens)> InsertPerRowAsync(List<UsageRecord> rows, CancellationToken ct)
    {
        var ok = 0;
        long tokens = 0;
        foreach (var r in rows)
        {
            try
            {
                db.UsageRecords.Add(r);
                await db.SaveChangesAsync(ct);
                ok++;
                tokens += TokensOf(r);
            }
            catch (DbUpdateException) { /* genuinely bad row or lost a race — drop it, keep going */ }
            finally { db.ChangeTracker.Clear(); }
        }
        return (ok, tokens);
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;

    /// <summary>Combined token count of a row (all input/output/cache tiers).</summary>
    private static long TokensOf(UsageRecord r) =>
        (long)r.InputTokens + r.OutputTokens + r.CacheReadTokens + r.CacheCreation5mTokens + r.CacheCreation1hTokens;

    private async Task<int> GetOrCreateProjectAsync(string cwd, Dictionary<string, int> cache, CancellationToken ct)
    {
        var (repoRoot, name) = ProjectResolver.Resolve(cwd);
        if (cache.TryGetValue(repoRoot, out var id)) return id;

        var proj = new Project { RepoRoot = repoRoot, Name = name, FolderName = null };
        try
        {
            db.Projects.Add(proj);
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
            id = proj.Id;
        }
        catch (DbUpdateException)
        {
            // Concurrent create of the same repo root — adopt the existing row.
            db.ChangeTracker.Clear();
            id = await db.Projects.AsNoTracking().Where(p => p.RepoRoot == repoRoot)
                .Select(p => p.Id).FirstAsync(ct);
        }
        cache[repoRoot] = id;
        return id;
    }

    /// <summary>One synthetic <see cref="IngestedFile"/> per (machine, source) so the FK is satisfied.</summary>
    private async Task<int> GetOrCreateRemoteFileAsync(string? machine, string source, CancellationToken ct)
    {
        var path = $"remote://{SanitizeMachine(machine)}/{source}";
        var existing = await db.IngestedFiles.AsNoTracking()
            .Where(f => f.Path == path).Select(f => f.Id).FirstOrDefaultAsync(ct);
        if (existing != 0) return existing;

        var file = new IngestedFile { Path = path, LastSyncUtc = DateTime.UtcNow };
        try
        {
            db.IngestedFiles.Add(file);
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
            return file.Id;
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            return await db.IngestedFiles.AsNoTracking()
                .Where(f => f.Path == path).Select(f => f.Id).FirstAsync(ct);
        }
    }

    // ---- untrusted-input hardening ----

    /// <summary>Validate + clamp one incoming row; returns null to drop a malformed row.</summary>
    private static ParsedUsage? Sanitize(ParsedUsage r)
    {
        var dedup = r.DedupKey?.Trim();
        if (string.IsNullOrEmpty(dedup) || dedup.Length > 300) return null; // DedupKey column max
        if (string.IsNullOrWhiteSpace(r.Model)) return null;
        if (r.TimestampUtc == default) return null;

        return r with
        {
            DedupKey = dedup,
            Model = Clamp(r.Model, 128),
            SessionId = Clamp(r.SessionId ?? "", 128),
            Cwd = r.Cwd is null ? null : Clamp(r.Cwd, 1024),
            GitBranch = r.GitBranch is null ? null : Clamp(r.GitBranch, 256),
            AgentId = r.AgentId is null ? null : Clamp(r.AgentId, 128),
            Version = r.Version is null ? null : Clamp(r.Version, 64),
            Input = ClampTokens(r.Input),
            Output = ClampTokens(r.Output),
            CacheRead = ClampTokens(r.CacheRead),
            Cache5m = ClampTokens(r.Cache5m),
            Cache1h = ClampTokens(r.Cache1h),
        };
    }

    /// <summary>
    /// Per-row token ceiling. Bounds the priced cost so it can never overflow the CostUsd
    /// numeric(18,8) column (which would otherwise throw on save), and mirrors the int token
    /// columns' range. A single real message's token count is orders of magnitude below this.
    /// </summary>
    private const long MaxTokens = int.MaxValue;
    private static long ClampTokens(long v) => Math.Clamp(v, 0, MaxTokens);
    private static string Clamp(string s, int max) => s.Length <= max ? s : s[..max];

    private static string SanitizeMachine(string? machine)
    {
        var m = (machine ?? "").Trim();
        if (m.Length == 0) return "unknown";
        // Keep it filesystem/URL-ish and bounded; the value is only an informational grouping label.
        var clean = new string(m.Where(c => !char.IsControl(c) && c != '/' && c != '\\').ToArray());
        clean = clean.Length == 0 ? "unknown" : clean;
        return clean.Length <= 64 ? clean : clean[..64];
    }

    private TimeZoneInfo ResolveTimeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Unknown timezone '{Tz}', falling back to local", id);
            return TimeZoneInfo.Local;
        }
    }
}
