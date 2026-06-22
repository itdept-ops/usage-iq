namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A split-the-check bill owned by one user. Items (<see cref="BillItem"/>) are assigned to contacts or
/// claimed by name via a PUBLIC, anonymous share link. The share token mirrors <see cref="ShareLink"/>:
/// only the SHA-256 HASH is the public lookup key, the token itself is stored AES-GCM-ENCRYPTED at rest
/// (via TokenProtector) so it can be re-copied, and a database leak alone can't reveal live links.
/// </summary>
public class Bill
{
    public int Id { get; set; }

    /// <summary>The owner's email (stored lower-cased) — every write is scoped to this.</summary>
    public string OwnerEmail { get; set; } = "";

    /// <summary>The owner's AppUser id (denormalized for display; the email is the scope key).</summary>
    public int OwnerUserId { get; set; }

    public string Title { get; set; } = "";
    public DateTime CreatedUtc { get; set; }

    /// <summary>Optional tax, split PROPORTIONALLY across each person's claimed/assigned item total.</summary>
    public decimal? TaxAmount { get; set; }

    /// <summary>Optional tip, split PROPORTIONALLY across each person's claimed/assigned item total.</summary>
    public decimal? TipAmount { get; set; }

    // ---- Public share link (mirrors ShareLink's hash+encrypted-token model) ----

    /// <summary>SHA-256 (hex) of the random 256-bit token — the deterministic key for the public claim lookup.</summary>
    public string? ShareTokenHash { get; set; }

    /// <summary>The token encrypted at rest (AES-GCM via TokenProtector) so the owner can re-copy the link.</summary>
    public string? ShareTokenEnc { get; set; }

    /// <summary>Whether the public claim link is live. When false the public endpoints return 404.</summary>
    public bool ShareEnabled { get; set; }

    /// <summary>"open" while collecting, "settled" once the owner closes it out.</summary>
    public string Status { get; set; } = "open";

    public List<BillItem> Items { get; set; } = new();
}
