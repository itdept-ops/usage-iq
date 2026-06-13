namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Tracks each JSONL file already processed so re-syncs can skip unchanged files
/// (matched on size + last-modified) and only reparse files that grew or rotated.
/// </summary>
public class IngestedFile
{
    public int Id { get; set; }

    /// <summary>Absolute file path (unique).</summary>
    public string Path { get; set; } = "";

    public DateTime LastModifiedUtc { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>Number of lines processed last time (informational / diagnostics).</summary>
    public int LinesIngested { get; set; }

    public DateTime LastSyncUtc { get; set; }
}
