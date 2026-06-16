using System.Diagnostics;
using Ccusage.Api.Ingestion;

namespace Ccusage.Reporter.Core;

/// <summary>Aggregate counters for one scan pass.</summary>
public sealed class ScanSummary
{
    public int FilesScanned { get; set; }
    public int FilesSkipped { get; set; }
    public int FilesParsed { get; set; }

    /// <summary>Rows the parsers produced (before local de-dup).</summary>
    public int RawRows { get; set; }
    /// <summary>Distinct rows actually pushed to the server.</summary>
    public int Sent { get; set; }
    public int Requests { get; set; }

    public int Inserted { get; set; }
    public int Duplicates { get; set; }
    public int Skipped { get; set; }

    /// <summary>Combined token count (all tiers) of the rows newly inserted this pass.</summary>
    public long InsertedTokens { get; set; }

    public long ElapsedMs { get; set; }
    public HashSet<string> Unpriced { get; } = new(StringComparer.Ordinal);

    /// <summary>Per-source (files scanned, files changed), for the pass breakdown.</summary>
    public List<(string Source, int Files, int Changed)> Sources { get; } = new();

    /// <summary>Redundant rows dropped before sending (one billed turn spans several identical-key lines).</summary>
    public int Redundant => Math.Max(0, RawRows - Sent);
    public bool Changed => FilesParsed > 0 || Inserted > 0;
    public double ElapsedSeconds => ElapsedMs / 1000.0;
}

/// <summary>
/// Walks each source's log tree, parses only files whose size/mtime changed since the last pass (via
/// <see cref="FileStateStore"/>), de-dups the rows locally (the raw JSONL repeats each turn across
/// several lines), and pushes the distinct rows to the server in batches coalesced across files. A
/// file's state is recorded only after its rows pushed successfully, so an interrupted push retries
/// next pass. Parsing happens locally; only token counts/metadata (never transcript text) are sent.
///
/// Progress is reported via a structured <see cref="ReporterEvent"/> callback (the <c>emit</c>
/// delegate) rather than the console — the engine forwards those to every subscriber.
/// </summary>
public sealed class LogScanner(IngestClient client, FileStateStore state, int batchSize, Action<ReporterEvent> emit)
{
    // Mirror the server's skip list so the two ingest paths consider the same files.
    private static readonly string[] SkipSegments = { @"\.tmp\", @"\node_modules\", "plugins-backup" };

    private const string Endpoint = "api/ingest";

    public async Task<ScanSummary> ScanAsync(string claudeRoot, string codexRoot, CancellationToken ct)
    {
        var summary = new ScanSummary();
        var sw = Stopwatch.StartNew();
        // Local de-dup across the whole pass: the parsers emit one row per content line, and a single
        // billed turn spans several lines that all carry the same key — send each key at most once.
        var seen = new HashSet<string>(StringComparer.Ordinal);

        await ScanSourceAsync("claude", new ClaudeParser(), claudeRoot, summary, seen, ct);
        await ScanSourceAsync("codex", new CodexParser(), codexRoot, summary, seen, ct);

        state.Save();
        summary.ElapsedMs = sw.ElapsedMilliseconds;
        return summary;
    }

    private async Task ScanSourceAsync(
        string kind, ISourceParser parser, string root, ScanSummary summary, HashSet<string> seen, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            return; // path not configured / not present on this machine — quietly skip

        // Coalesce distinct rows ACROSS files into batches: a backfill of thousands of small files
        // becomes ~rows/batchSize requests, not one per file (which would trip the rate limit).
        var buffer = new List<ParsedUsage>(batchSize);
        var staged = new List<(string path, long size, DateTime mtime)>();
        var scanned = 0;
        var changed = 0;

        foreach (var path in SafeEnumerateFiles(root))
        {
            ct.ThrowIfCancellationRequested();
            var name = Path.GetFileName(path);
            if (ShouldSkip(path) || !parser.MatchesFile(name)) continue;

            scanned++;
            summary.FilesScanned++;

            long size;
            DateTime mtime;
            try { var fi = new FileInfo(path); size = fi.Length; mtime = fi.LastWriteTimeUtc; }
            catch { continue; }

            if (state.IsUnchanged(path, size, mtime)) continue;

            List<ParsedUsage> rows;
            try { rows = ParseFile(parser, path, name); }
            catch (Exception ex) { emit(ReporterEvent.Warning($"{kind}: parse failed ({name}): {ex.Message}", ex)); continue; }

            changed++;
            summary.FilesParsed++;
            summary.RawRows += rows.Count;
            var added = 0;
            foreach (var r in rows) if (seen.Add(r.DedupKey)) { buffer.Add(r); added++; } // local de-dup
            staged.Add((path, size, mtime));
            if (added > 0) emit(ReporterEvent.RowsFound(kind, added, changed));

            if (buffer.Count >= batchSize) await FlushAsync(kind, buffer, staged, summary, ct);
            if ((scanned & 127) == 0)
                emit(ReporterEvent.FileScanned(kind, scanned, changed, summary.Sent));
        }

        await FlushAsync(kind, buffer, staged, summary, ct); // final flush (also commits 0-row changed files)
        summary.FilesSkipped += scanned - changed;
        if (scanned > 0)
        {
            summary.Sources.Add((kind, scanned, changed));
            emit(ReporterEvent.FileScanned(kind, scanned, changed, summary.Sent));
        }
    }

    /// <summary>Push the buffered distinct rows in wire-sized chunks, then commit every staged file's state.</summary>
    private async Task FlushAsync(
        string kind, List<ParsedUsage> buffer, List<(string path, long size, DateTime mtime)> staged,
        ScanSummary summary, CancellationToken ct)
    {
        if (buffer.Count > 0)
        {
            for (var i = 0; i < buffer.Count; i += batchSize)
            {
                var chunk = buffer.GetRange(i, Math.Min(batchSize, buffer.Count - i));
                emit(ReporterEvent.BatchPosting(kind, Endpoint, chunk.Count));

                var res = await client.PushAsync(kind, chunk, ct);
                summary.Sent += res.Received;
                summary.Inserted += res.Inserted;
                summary.InsertedTokens += res.InsertedTokens;
                summary.Duplicates += res.Duplicates;
                summary.Skipped += res.Skipped;
                summary.Requests++;
                if (res.UnpricedModels is { } um) foreach (var m in um) summary.Unpriced.Add(m);

                // A successful PushAsync return always implies a 2xx (non-2xx either retried or threw).
                emit(ReporterEvent.BatchPosted(kind, Endpoint, res.Received, res.Inserted, res.Duplicates, 200));
                emit(ReporterEvent.TokensSynced(summary.InsertedTokens, res.InsertedTokens, 0m));
            }
        }

        // Only after the rows pushed successfully are these files safe to mark seen.
        foreach (var f in staged) state.Record(f.path, f.size, f.mtime);
        if (staged.Count > 0) state.Save();   // durability between flushes on long backfills

        buffer.Clear();
        staged.Clear();
    }

    private static List<ParsedUsage> ParseFile(ISourceParser parser, string path, string name)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        return parser.Parse(reader, name).ToList();
    }

    private static bool ShouldSkip(string path) =>
        SkipSegments.Any(seg => path.Contains(seg, StringComparison.OrdinalIgnoreCase));

    /// <summary>Recursive *.jsonl walk that tolerates inaccessible directories instead of aborting the pass.</summary>
    private static IEnumerable<string> SafeEnumerateFiles(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();

            string[] subdirs;
            try { subdirs = Directory.GetDirectories(dir); }
            catch { subdirs = Array.Empty<string>(); }
            foreach (var sub in subdirs) stack.Push(sub);

            string[] files;
            try { files = Directory.GetFiles(dir, "*.jsonl"); }
            catch { files = Array.Empty<string>(); }
            foreach (var f in files) yield return f;
        }
    }
}
