namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A personal, per-user saved dashboard filter. Owned by exactly one <see cref="AppUser"/>
/// and deleted with that user (cascade) — saved views are private and die with the account.
/// The dashboard filter payload is stored as explicit columns rather than a blob so it can
/// be inspected/queried and round-trips cleanly through the DTO.
/// </summary>
public class SavedView
{
    public int Id { get; set; }

    /// <summary>Owner. Required; ON DELETE CASCADE — a user's views are removed with them.</summary>
    public int UserId { get; set; }
    public AppUser? User { get; set; }

    /// <summary>Display name, unique per user (upsert-by-name on create).</summary>
    public string Name { get; set; } = "";

    // ---- Dashboard filter payload (mirrors UsageFilterQuery + groupBy) ----
    public DateOnly? FromDate { get; set; }
    public DateOnly? ToDate { get; set; }

    /// <summary>Comma-separated project ids (empty = all).</summary>
    public string ProjectIdsCsv { get; set; } = "";

    /// <summary>Comma-separated model strings (empty = all).</summary>
    public string ModelsCsv { get; set; } = "";

    /// <summary>Comma-separated source names (empty = all).</summary>
    public string SourcesCsv { get; set; } = "";

    public bool IncludeSidechain { get; set; } = true;

    /// <summary>Summary grouping, e.g. "day", "model", "project".</summary>
    public string GroupBy { get; set; } = "day";

    public DateTime CreatedUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
}
