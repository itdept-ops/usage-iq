namespace Ccusage.Api.Ingestion;

/// <summary>Summary of a sync run, returned by <c>POST /api/sync</c>.</summary>
public sealed class SyncResult
{
    public string ProjectsPath { get; set; } = "";
    public string TimeZone { get; set; } = "";

    public int FilesScanned { get; set; }
    public int FilesParsed { get; set; }
    public int FilesSkipped { get; set; }

    public long TotalLines { get; set; }
    public int MalformedLines { get; set; }

    /// <summary>Newly inserted (de-duplicated) usage rows.</summary>
    public int NewRecords { get; set; }

    /// <summary>Distinct model strings that fell through to the <c>*</c> fallback (need pricing).</summary>
    public List<string> UnpricedModels { get; set; } = new();

    public long DurationMs { get; set; }
    public string? Error { get; set; }
    public string? Warning { get; set; }
}
