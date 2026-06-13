namespace Ccusage.Api.Data.Entities;

/// <summary>Single-row record of the most recent sync (manual or background timer).</summary>
public class SyncStatus
{
    public int Id { get; set; }

    public DateTime? LastSyncUtc { get; set; }
    public int LastNewRecords { get; set; }
    public long LastDurationMs { get; set; }
    public int LastFilesParsed { get; set; }
    public int LastFilesScanned { get; set; }
    public string? LastError { get; set; }
}
