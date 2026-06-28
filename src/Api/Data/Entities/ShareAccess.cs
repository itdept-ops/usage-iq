namespace Ccusage.Api.Data.Entities;

/// <summary>One anonymous view of a public share link — when, and from which client IP. Reused for BOTH
/// usage-share links (<see cref="ShareLinkId"/>) and Wrapped-share links (<see cref="WrappedShareLinkId"/>):
/// exactly one FK is set per row (the other is null), avoiding a parallel access-log table.</summary>
public class ShareAccess
{
    public long Id { get; set; }

    /// <summary>The usage <see cref="ShareLink"/> viewed, when this row logs a usage-share view (else null).</summary>
    public int? ShareLinkId { get; set; }
    public ShareLink? ShareLink { get; set; }

    /// <summary>The <see cref="WrappedShareLink"/> viewed, when this row logs a Wrapped-share view (else null).</summary>
    public int? WrappedShareLinkId { get; set; }
    public WrappedShareLink? WrappedShareLink { get; set; }

    public DateTime WhenUtc { get; set; }
    public string? Ip { get; set; }
}
