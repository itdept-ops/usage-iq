namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One de-duplicated assistant API turn (a single billed message). Raw JSONL emits
/// many lines per turn that all echo the same usage; we keep exactly one row per
/// <see cref="DedupKey"/>.
/// </summary>
public class UsageRecord
{
    public long Id { get; set; }

    /// <summary>The <c>message.id</c> (e.g. <c>msg_…</c>).</summary>
    /// <summary>Which tool produced this usage, e.g. <c>claude-code</c> or <c>codex</c>.</summary>
    public string Source { get; set; } = "claude-code";

    public string MessageId { get; set; } = "";

    /// <summary>The top-level <c>requestId</c> (e.g. <c>req_…</c>); null for some synthetic rows.</summary>
    public string? RequestId { get; set; }

    /// <summary><c>MessageId + "|" + (RequestId ?? "")</c> — the unique de-duplication key.</summary>
    public string DedupKey { get; set; } = "";

    /// <summary>Original event time, stored in UTC.</summary>
    public DateTime TimestampUtc { get; set; }

    /// <summary>Calendar date of the event in the configured display timezone (for day/month rollups).</summary>
    public DateOnly LocalDate { get; set; }

    public string Model { get; set; } = "";

    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }

    /// <summary>Cache-read tokens (cheap, but huge volume — kept as 64-bit).</summary>
    public long CacheReadTokens { get; set; }

    /// <summary>5-minute ephemeral cache-write tokens.</summary>
    public int CacheCreation5mTokens { get; set; }

    /// <summary>1-hour ephemeral cache-write tokens (priced higher than 5m).</summary>
    public int CacheCreation1hTokens { get; set; }

    public string SessionId { get; set; } = "";

    public int ProjectId { get; set; }
    public Project? Project { get; set; }

    public string Cwd { get; set; } = "";
    public string? GitBranch { get; set; }

    /// <summary>True for subagent / sidechain turns (real spend; counted by default).</summary>
    public bool IsSidechain { get; set; }
    public string? AgentId { get; set; }

    /// <summary>Claude Code client version that produced the record.</summary>
    public string? Version { get; set; }

    /// <summary>Computed USD cost (denormalized; recomputed when pricing changes).</summary>
    public decimal CostUsd { get; set; }

    /// <summary>
    /// The reporting machine/host this row was pushed from (sanitized <c>batch.Machine</c>). Empty
    /// for the local file-sync path (treated as "local" in fleet rollups). Indexed for grouping.
    /// </summary>
    public string MachineName { get; set; } = "";

    /// <summary>
    /// The email of the ingest-key owner that authenticated the remote push (server-derived — never
    /// from the client payload, so attribution can't be spoofed). Empty for local/file ingestion
    /// (treated as "unknown"/"local"). Indexed for grouping.
    /// </summary>
    public string ReportedByUser { get; set; } = "";

    /// <summary>The file this row was first ingested from (informational). Nullable: the usage/cost row is the
    /// authoritative billing ledger and must survive a purge of the file-tracking row (the FK is SET NULL on
    /// delete, mirroring the IngestKey.UserId "orphan instead of cascade" decision).</summary>
    public int? IngestedFileId { get; set; }
    public IngestedFile? IngestedFile { get; set; }
}
