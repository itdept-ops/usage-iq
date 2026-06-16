using Ccusage.Api.Ingestion;

namespace Ccusage.Api.Dtos;

/// <summary>
/// A batch pushed by a remote reporter to <c>POST /api/ingest</c>. Rows are the source-neutral
/// <see cref="ParsedUsage"/> the reporter parsed locally — no raw transcript text leaves the machine.
/// </summary>
public sealed class IngestBatchDto
{
    /// <summary>Parser kind that produced these rows: <c>claude</c> or <c>codex</c>.</summary>
    public string Source { get; set; } = "";

    /// <summary>Optional machine/host identifier (groups rows under a synthetic remote "file").</summary>
    public string? Machine { get; set; }

    /// <summary>Optional reporter version string (informational).</summary>
    public string? Reporter { get; set; }

    public List<ParsedUsage> Rows { get; set; } = new();
}

/// <summary>Outcome of an ingest batch. Received == Inserted + Duplicates + Skipped.</summary>
public sealed class IngestResultDto
{
    public int Received { get; set; }
    public int Inserted { get; set; }
    /// <summary>Combined token count (all tiers) of the rows actually inserted.</summary>
    public long InsertedTokens { get; set; }
    /// <summary>Rows whose key already existed in the DB.</summary>
    public int Duplicates { get; set; }
    /// <summary>Rows dropped before/at insert: malformed, collapsed within-batch, or DB-rejected.</summary>
    public int Skipped { get; set; }
    public string[] UnpricedModels { get; set; } = Array.Empty<string>();
}

/// <summary>Admin-facing view of an ingest key (never includes the raw key).</summary>
public sealed class IngestKeyDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public string CreatedByEmail { get; set; } = "";
    public DateTime? LastUsedUtc { get; set; }
    public string? LastUsedIp { get; set; }
    public bool Revoked { get; set; }
}

/// <summary>The one-time response when a key is created — carries the raw key.</summary>
public sealed class IngestKeyCreatedDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    /// <summary>The full raw key — shown once and never retrievable again.</summary>
    public string Key { get; set; } = "";
}

public sealed class CreateIngestKeyRequest
{
    public string? Name { get; set; }
}
