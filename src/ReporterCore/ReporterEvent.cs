namespace Ccusage.Reporter.Core;

/// <summary>
/// The kind of progress signal a <see cref="ReporterEngine"/> emits. Listeners (console HUD, GUI,
/// tests) switch on this to decide how to render. The engine never writes to the console itself.
/// </summary>
public enum ReporterEventKind
{
    /// <summary>A scan/post pass is beginning.</summary>
    PassStarted,
    /// <summary>The scanner finished walking a source's tree (running file/changed tallies).</summary>
    FileScanned,
    /// <summary>Distinct rows were parsed out of changed files (before any push).</summary>
    RowsFound,
    /// <summary>A batch is about to be POSTed to the ingest endpoint.</summary>
    BatchPosting,
    /// <summary>A batch POST returned (carries endpoint, row count, inserted/duplicates, HTTP status).</summary>
    BatchPosted,
    /// <summary>Tokens were synced this pass; carries the running combined token total + cost.</summary>
    TokensSynced,
    /// <summary>A non-fatal problem (parse failure, unpriced models, transient retry).</summary>
    Warning,
    /// <summary>A fatal problem that stops the run (e.g. a rejected ingest key).</summary>
    Error,
    /// <summary>Watch mode is idle until the next run; carries the next-run time / countdown.</summary>
    Idle,
    /// <summary>The pass finished; carries the full per-pass <see cref="ScanSummary"/>.</summary>
    PassCompleted,
}

/// <summary>
/// A single structured progress event raised by <see cref="ReporterEngine"/>. Most fields are
/// kind-specific and null/zero when not applicable — use the static factories rather than the
/// constructor so each kind is populated consistently. This type carries no console concerns; it is
/// the contract every listener (console, GUI, logger) subscribes to.
/// </summary>
public sealed record ReporterEvent
{
    /// <summary>Which kind of event this is. Listeners switch on this.</summary>
    public required ReporterEventKind Kind { get; init; }

    /// <summary>When the event was raised (local time).</summary>
    public DateTime Timestamp { get; init; } = DateTime.Now;

    /// <summary>Human-readable one-line message, suitable for a log line.</summary>
    public string Message { get; init; } = "";

    // ---- scan progress (FileScanned / RowsFound) ----
    /// <summary>Source kind in play, e.g. "claude" or "codex". Null for whole-pass events.</summary>
    public string? Source { get; init; }
    /// <summary>Files looked at so far this pass.</summary>
    public int FilesScanned { get; init; }
    /// <summary>Files that changed (and were parsed) so far this pass.</summary>
    public int FilesChanged { get; init; }
    /// <summary>Distinct rows discovered (after local de-dup) — for the RowsFound kind.</summary>
    public int RowsFoundCount { get; init; }

    // ---- batch post (BatchPosting / BatchPosted) ----
    /// <summary>The endpoint the batch is/was POSTed to (e.g. "api/ingest").</summary>
    public string? Endpoint { get; init; }
    /// <summary>Rows in this batch.</summary>
    public int RowCount { get; init; }
    /// <summary>Rows the server newly inserted from this batch.</summary>
    public int Inserted { get; init; }
    /// <summary>Rows the server already had (duplicates) from this batch.</summary>
    public int Duplicates { get; init; }
    /// <summary>HTTP status returned by the batch POST (200 on success).</summary>
    public int HttpStatus { get; init; }

    // ---- tokens / cost (TokensSynced) ----
    /// <summary>Running combined token total across this pass (all tiers).</summary>
    public long TotalTokens { get; init; }
    /// <summary>Tokens added by the most recent batch.</summary>
    public long TokenDelta { get; init; }
    /// <summary>Running estimated cost for the tokens synced this pass, if the server reports it.</summary>
    public decimal Cost { get; init; }

    // ---- idle (Idle) ----
    /// <summary>When the next pass will run (watch mode). Null outside Idle.</summary>
    public DateTime? NextRunAt { get; init; }
    /// <summary>Seconds until the next pass (watch mode).</summary>
    public int SecondsUntilNext { get; init; }

    // ---- completion (PassCompleted) ----
    /// <summary>The full pass summary. Non-null only for PassCompleted.</summary>
    public ScanSummary? Summary { get; init; }

    /// <summary>The exception behind an Error/Warning, if any (never logged raw by the engine).</summary>
    public Exception? Exception { get; init; }

    // ---- factories: one per kind so callers can't forget a field ----

    public static ReporterEvent PassStarted(bool once) =>
        new() { Kind = ReporterEventKind.PassStarted, Message = once ? "starting one-shot pass" : "starting scan pass" };

    public static ReporterEvent FileScanned(string source, int filesScanned, int filesChanged, long sentRows) => new()
    {
        Kind = ReporterEventKind.FileScanned,
        Source = source,
        FilesScanned = filesScanned,
        FilesChanged = filesChanged,
        Message = $"scanning {source} — {filesScanned:N0} files, {filesChanged:N0} changed, {sentRows:N0} sent",
    };

    public static ReporterEvent RowsFound(string source, int rows, int filesChanged) => new()
    {
        Kind = ReporterEventKind.RowsFound,
        Source = source,
        RowsFoundCount = rows,
        FilesChanged = filesChanged,
        Message = $"{source}: {rows:N0} new row(s) in {filesChanged:N0} changed file(s)",
    };

    public static ReporterEvent BatchPosting(string source, string endpoint, int rowCount) => new()
    {
        Kind = ReporterEventKind.BatchPosting,
        Source = source,
        Endpoint = endpoint,
        RowCount = rowCount,
        Message = $"posting {rowCount:N0} {source} row(s) → {endpoint}",
    };

    public static ReporterEvent BatchPosted(
        string source, string endpoint, int rowCount, int inserted, int duplicates, int httpStatus) => new()
    {
        Kind = ReporterEventKind.BatchPosted,
        Source = source,
        Endpoint = endpoint,
        RowCount = rowCount,
        Inserted = inserted,
        Duplicates = duplicates,
        HttpStatus = httpStatus,
        Message = $"{endpoint} {httpStatus}: {inserted:N0} new, {duplicates:N0} dup of {rowCount:N0}",
    };

    public static ReporterEvent TokensSynced(long totalTokens, long delta, decimal cost) => new()
    {
        Kind = ReporterEventKind.TokensSynced,
        TotalTokens = totalTokens,
        TokenDelta = delta,
        Cost = cost,
        Message = $"tokens synced — {totalTokens:N0} combined this pass",
    };

    public static ReporterEvent Warning(string message, Exception? ex = null) =>
        new() { Kind = ReporterEventKind.Warning, Message = message, Exception = ex };

    public static ReporterEvent Error(string message, Exception? ex = null) =>
        new() { Kind = ReporterEventKind.Error, Message = message, Exception = ex };

    public static ReporterEvent Idle(DateTime nextRunAt, int secondsUntilNext) => new()
    {
        Kind = ReporterEventKind.Idle,
        NextRunAt = nextRunAt,
        SecondsUntilNext = secondsUntilNext,
        Message = $"watching for changes — next scan {nextRunAt:HH:mm:ss}",
    };

    public static ReporterEvent PassCompleted(ScanSummary summary) => new()
    {
        Kind = ReporterEventKind.PassCompleted,
        Summary = summary,
        TotalTokens = summary.InsertedTokens,
        Message = summary.Inserted > 0
            ? $"synced {summary.Inserted:N0} new row(s) in {summary.ElapsedSeconds:0.0}s"
            : $"scanned in {summary.ElapsedSeconds:0.0}s — nothing new",
    };
}
