namespace Ccusage.Api.Data.Entities;

/// <summary>How a <see cref="IdentityTimeEntry"/> came to exist.</summary>
public enum IdentityEntrySource
{
    /// <summary>Hand-logged by the owner (the always-available baseline).</summary>
    Manual = 0,
    /// <summary>Imported from the owner's connected Google Calendar (carries a <see cref="IdentityTimeEntry.SourceEventId"/>).</summary>
    Calendar = 1,
    /// <summary>Auto-derived from the owner's OWN recent Hub activity (workouts, completed chores) and applied
    /// by the owner. Carries a synthetic <see cref="IdentityTimeEntry.SourceEventId"/> ("auto:{signal}:{date}")
    /// so re-applying the same day is idempotent via the filtered UNIQUE (UserEmail, SourceEventId) index —
    /// "Refresh then Apply again" never double-counts. NEVER derived from anyone else's data.</summary>
    Auto = 2,
}

/// <summary>
/// One block of TIME attributed to a role on a given day. OWNER-SCOPED private data: a row exists only because
/// the owner logged it (manual) or imported it from their OWN connected calendar; ONLY the owner ever reads or
/// edits it (every endpoint binds the caller's email). Indexed (UserEmail, Date desc) for the range read +
/// chart aggregation. A FILTERED UNIQUE (UserEmail, SourceEventId) WHERE SourceEventId IS NOT NULL makes
/// calendar re-import idempotent — the same Google event can never be double-counted.
/// </summary>
public class IdentityTimeEntry
{
    public int Id { get; set; }

    /// <summary>The owner, stored lower-cased (the identity key; indexed with <see cref="Date"/> desc).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins.</summary>
    public int UserId { get; set; }

    /// <summary>The role this time is attributed to (FK → <see cref="IdentityRole.Id"/>; owner-scoped).</summary>
    public int RoleId { get; set; }

    /// <summary>The day the time is attributed to.</summary>
    public DateOnly Date { get; set; }

    /// <summary>Minutes spent (1..1440, clamped at the endpoint).</summary>
    public int Minutes { get; set; }

    /// <summary>Where this entry came from (manual vs calendar import).</summary>
    public IdentityEntrySource Source { get; set; }

    /// <summary>The Google event id for calendar rows (the dedup key); null for manual entries.</summary>
    public string? SourceEventId { get; set; }

    /// <summary>An optional short label (e.g. the source event title); never logged anywhere.</summary>
    public string? Note { get; set; }

    /// <summary>When this entry was created (UTC).</summary>
    public DateTime CreatedUtc { get; set; }
}
