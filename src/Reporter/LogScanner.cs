using Ccusage.Api.Ingestion;

namespace Ccusage.Reporter;

/// <summary>Aggregate counters for one scan pass.</summary>
public sealed class ScanSummary
{
    public int FilesScanned { get; set; }
    public int FilesSkipped { get; set; }
    public int FilesParsed { get; set; }
    public int FilesPushed { get; set; }
    public int Received { get; set; }
    public int Inserted { get; set; }
    public int Duplicates { get; set; }
    public int Skipped { get; set; }
    public HashSet<string> Unpriced { get; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Walks each source's log tree, parses only files whose size/mtime changed since the last pass (via
/// <see cref="FileStateStore"/>), and pushes the parsed rows to the server in batches. A file's state
/// is recorded only after all of its rows pushed successfully, so an interrupted push is retried next
/// pass. Parsing happens locally with the same parsers the server uses; only token counts/metadata
/// (never transcript text) are sent.
/// </summary>
public sealed class LogScanner(IngestClient client, FileStateStore state, int batchSize, Action<string> log)
{
    // Mirror the server's skip list so the two ingest paths consider the same files.
    private static readonly string[] SkipSegments = { @"\.tmp\", @"\node_modules\", "plugins-backup" };

    public async Task<ScanSummary> ScanAsync(string claudeRoot, string codexRoot, CancellationToken ct)
    {
        var summary = new ScanSummary();
        await ScanSourceAsync("claude", new ClaudeParser(), claudeRoot, summary, ct);
        await ScanSourceAsync("codex", new CodexParser(), codexRoot, summary, ct);
        state.Save();
        return summary;
    }

    private async Task ScanSourceAsync(
        string kind, ISourceParser parser, string root, ScanSummary summary, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            log($"  [{kind}] path not found, skipping: {root}");
            return;
        }

        // Coalesce rows ACROSS files into batches: a backfill of thousands of small files becomes
        // ~rows/batchSize requests instead of one request per file (which would trip the rate limit).
        var buffer = new List<ParsedUsage>(batchSize);
        var staged = new List<(string path, long size, DateTime mtime)>();

        foreach (var path in SafeEnumerateFiles(root))
        {
            ct.ThrowIfCancellationRequested();
            var name = Path.GetFileName(path);
            if (ShouldSkip(path) || !parser.MatchesFile(name)) continue;

            summary.FilesScanned++;

            long size;
            DateTime mtime;
            try { var fi = new FileInfo(path); size = fi.Length; mtime = fi.LastWriteTimeUtc; }
            catch { continue; }

            if (state.IsUnchanged(path, size, mtime)) { summary.FilesSkipped++; continue; }

            List<ParsedUsage> rows;
            try { rows = ParseFile(parser, path, name); }
            catch (Exception ex) { log($"  [{kind}] parse failed ({name}): {ex.Message}"); continue; }

            summary.FilesParsed++;
            buffer.AddRange(rows);
            staged.Add((path, size, mtime));

            // Flush at a file boundary once we have enough rows — staged files are then fully sent.
            if (buffer.Count >= batchSize)
                await FlushAsync(kind, buffer, staged, summary, ct);
        }

        // Final flush for this source (also records state for changed files that parsed to 0 rows).
        await FlushAsync(kind, buffer, staged, summary, ct);
    }

    /// <summary>Push the buffered rows in wire-sized chunks, then commit every staged file's state.</summary>
    private async Task FlushAsync(
        string kind, List<ParsedUsage> buffer, List<(string path, long size, DateTime mtime)> staged,
        ScanSummary summary, CancellationToken ct)
    {
        if (buffer.Count > 0)
        {
            for (var i = 0; i < buffer.Count; i += batchSize)
            {
                var chunk = buffer.GetRange(i, Math.Min(batchSize, buffer.Count - i));
                var res = await client.PushAsync(kind, chunk, ct);
                summary.Received += res.Received;
                summary.Inserted += res.Inserted;
                summary.Duplicates += res.Duplicates;
                summary.Skipped += res.Skipped;
                if (res.UnpricedModels is { } um) foreach (var m in um) summary.Unpriced.Add(m);
            }
            summary.FilesPushed += staged.Count;
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
