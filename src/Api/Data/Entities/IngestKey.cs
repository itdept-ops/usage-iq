namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A bearer credential a remote <c>Ccusage.Reporter</c> uses to push parsed usage to
/// <c>POST /api/ingest</c>. Only the SHA-256 <see cref="KeyHash"/> is stored — the raw key is shown
/// to the admin exactly once at creation and never persisted. Revoking sets <see cref="RevokedUtc"/>;
/// a revoked key is rejected on the next request.
/// </summary>
public class IngestKey
{
    public int Id { get; set; }

    /// <summary>Human label (e.g. the machine or person the key was issued for).</summary>
    public string Name { get; set; } = "";

    /// <summary>Hex SHA-256 of the raw key — the lookup value. The raw key is never stored.</summary>
    public string KeyHash { get; set; } = "";

    /// <summary>A short, non-secret prefix of the raw key for display (e.g. <c>uiq_AbCdEf…</c>).</summary>
    public string Prefix { get; set; } = "";

    public DateTime CreatedUtc { get; set; }
    public string CreatedByEmail { get; set; } = "";

    /// <summary>When the key was last accepted on an ingest request (best-effort).</summary>
    public DateTime? LastUsedUtc { get; set; }
    public string? LastUsedIp { get; set; }

    /// <summary>Set when the key is revoked; a revoked key is no longer accepted.</summary>
    public DateTime? RevokedUtc { get; set; }
}
