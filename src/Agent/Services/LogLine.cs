using Ccusage.Reporter.Core;

namespace UsageIq.Agent.Services;

/// <summary>Severity of a log line, mapped to a brand color in the live view.</summary>
public enum LogSeverity { Info, Scan, Post, Success, Warning, Error }

/// <summary>
/// One immutable, timestamped line for the live log/request view. Built from a <see cref="ReporterEvent"/>
/// (or directly for agent-level notices). Carries only token counts/metadata — the ingest key is never
/// part of a <see cref="ReporterEvent"/> and is never reconstructed here.
/// </summary>
public sealed record LogLine
{
    public DateTime Timestamp { get; init; } = DateTime.Now;
    public LogSeverity Severity { get; init; } = LogSeverity.Info;
    public string Text { get; init; } = "";

    /// <summary>HH:mm:ss stamp for the gutter column.</summary>
    public string Time => Timestamp.ToString("HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A short tag shown before the message, e.g. SCAN / POST / OK.</summary>
    public string Tag => Severity switch
    {
        LogSeverity.Scan => "SCAN",
        LogSeverity.Post => "POST",
        LogSeverity.Success => "OK",
        LogSeverity.Warning => "WARN",
        LogSeverity.Error => "ERR",
        _ => "•",
    };

    public static LogLine Info(string text) => new() { Severity = LogSeverity.Info, Text = text };
    public static LogLine Warn(string text) => new() { Severity = LogSeverity.Warning, Text = text };

    /// <summary>
    /// Render a reporter event as a log line. POST lines explicitly show the endpoint, row count, HTTP
    /// status, and tokens — exactly what a transparency-first view should expose — and never the key.
    /// </summary>
    public static LogLine FromEvent(ReporterEvent e) => e.Kind switch
    {
        ReporterEventKind.PassStarted =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Info, Text = "scan pass started" },

        ReporterEventKind.FileScanned =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Scan,
                    Text = $"{e.Source}: scanned {e.FilesScanned:N0} files, {e.FilesChanged:N0} changed" },

        ReporterEventKind.RowsFound =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Scan,
                    Text = $"{e.Source}: parsed {e.RowsFoundCount:N0} new row(s) from {e.FilesChanged:N0} changed file(s)" },

        ReporterEventKind.BatchPosting =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Post,
                    Text = $"POST {e.Endpoint} — {e.RowCount:N0} {e.Source} row(s) →" },

        ReporterEventKind.BatchPosted =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Post,
                    Text = $"POST {e.Endpoint} {e.HttpStatus}: {e.Inserted:N0} new, {e.Duplicates:N0} dup of {e.RowCount:N0}" },

        ReporterEventKind.TokensSynced =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Success,
                    Text = $"tokens synced — +{AgentStatus.FormatTokens(e.TokenDelta)} ({AgentStatus.FormatTokens(e.TotalTokens)} this pass)" },

        ReporterEventKind.Warning =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Warning, Text = e.Message },

        ReporterEventKind.Error =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Error, Text = e.Message },

        ReporterEventKind.Idle =>
            new() { Timestamp = e.Timestamp, Severity = LogSeverity.Info,
                    Text = $"idle — next scan {e.NextRunAt:HH:mm:ss}" },

        ReporterEventKind.PassCompleted =>
            new() { Timestamp = e.Timestamp,
                    Severity = e.Summary is { Inserted: > 0 } ? LogSeverity.Success : LogSeverity.Info,
                    Text = e.Message },

        _ => new() { Timestamp = e.Timestamp, Severity = LogSeverity.Info, Text = e.Message },
    };
}
