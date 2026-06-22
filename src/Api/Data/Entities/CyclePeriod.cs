namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One logged period for a user. PRIVATE health data: a row exists only because the owner (who holds
/// <c>cycle.track</c>) logged it, and ONLY the owner ever reads or edits it (owner-scoped on every endpoint).
/// The family-calendar overlay NEVER exposes these raw rows — it derives PREDICTED day-spans from them.
/// Indexed (UserEmail, StartDate desc) for the newest-first own reads + the gap-based prediction.
/// </summary>
public class CyclePeriod
{
    public int Id { get; set; }

    /// <summary>The owner, stored lower-cased (the identity key; indexed with <see cref="StartDate"/> desc).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins.</summary>
    public int UserId { get; set; }

    /// <summary>The day the period started (the anchor for cycle-length gaps + the next-start prediction).</summary>
    public DateOnly StartDate { get; set; }

    /// <summary>The day the period ended, when the owner recorded one (null = ongoing / not yet recorded).</summary>
    public DateOnly? EndDate { get; set; }

    /// <summary>When this entry was logged (UTC).</summary>
    public DateTime LoggedUtc { get; set; }
}
