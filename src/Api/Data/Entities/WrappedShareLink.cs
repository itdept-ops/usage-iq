namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A public, unauthenticated, time-limited link to ONE person's "Year in the Hub" (Wrapped) recap.
/// A near-clone of <see cref="ShareLink"/> but scoped to a Wrapped period instead of a usage filter.
/// Only the SHA-256 hash of the token is stored, so a database leak can't reveal live links.
///
/// EVERYTHING the public read needs is BAKED IN at creation and enforced server-side — the holder can
/// NEVER widen it:
/// <list type="bullet">
///   <item><see cref="OwnerEmail"/> — WHOSE recap this is. The public read rebuilds the recap from this
///   email server-side; the holder cannot point the link at anyone else.</item>
///   <item><see cref="Period"/> + <see cref="FromDate"/>/<see cref="ToDate"/> — the FROZEN window.</item>
///   <item><see cref="CardWhitelist"/> — the PII-safe card keys the public read is filtered to. Sensitive
///   cards (weight/sleep/finance/location) are default-EXCLUDED at create time.</item>
///   <item><see cref="NarrativeSnapshot"/> + <see cref="InsightsSnapshot"/> — the AI narrative is generated
///   ONCE at create time against ONLY the whitelisted cards and FROZEN here, so the anonymous path serves a
///   cached snapshot and NEVER makes a live (token-spending) Gemini call.</item>
/// </list>
/// Per-view logging reuses <see cref="ShareAccess"/> via its nullable <see cref="ShareAccess.WrappedShareLinkId"/>.
/// </summary>
public class WrappedShareLink
{
    public int Id { get; set; }

    /// <summary>SHA-256 (hex) of the random token — the deterministic key for the public lookup.</summary>
    public string TokenHash { get; set; } = "";

    /// <summary>The token encrypted at rest (AES-GCM via TokenProtector) so the link can be re-copied.</summary>
    public string? TokenEnc { get; set; }

    public string? Label { get; set; }
    public string CreatedByEmail { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }

    // ---- Baked-in, server-enforced scope (the holder can NEVER widen any of these) ----

    /// <summary>WHOSE recap this is. The public read derives the recap from THIS email, never the caller's input.</summary>
    public string OwnerEmail { get; set; } = "";

    /// <summary>The frozen period token: month | year | all.</summary>
    public string Period { get; set; } = "month";

    public DateOnly FromDate { get; set; }
    public DateOnly ToDate { get; set; }

    /// <summary>The PII-safe card keys this link may expose. The public read FILTERS to exactly this set
    /// (server-side), so an excluded sensitive card can never reach an anonymous viewer.</summary>
    public string[] CardWhitelist { get; set; } = Array.Empty<string>();

    /// <summary>The frozen AI narrative, generated ONCE at create time against ONLY the whitelisted cards.
    /// Served verbatim on the anonymous path — NO live Gemini call (no unauthenticated token spend).</summary>
    public string NarrativeSnapshot { get; set; } = "";

    /// <summary>The frozen insight bullets that accompany the narrative (stored as a Postgres text[]).</summary>
    public string[] InsightsSnapshot { get; set; } = Array.Empty<string>();

    public int AccessCount { get; set; }
    public DateTime? LastAccessedUtc { get; set; }
}
