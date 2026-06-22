namespace Ccusage.Api.Data.Entities;

/// <summary>
/// The flow level a logged day records, stored as its int (none=0 .. heavy=4). Informational only — the
/// deterministic predictor may treat a <see cref="Heavy"/> day as corroboration of a period day, but it is
/// NEVER diagnostic.
/// </summary>
public enum CycleFlowLevel
{
    None = 0,
    Spotting = 1,
    Light = 2,
    Medium = 3,
    Heavy = 4,
}

/// <summary>
/// One day's optional self-log for the cycle tracker — HEALTH + INTIMATE data, the most sensitive rows in the
/// app. A row exists only because the owner (who holds <c>cycle.track</c>) logged it, and ONLY the owner ever
/// reads or writes it (owner-scoped on every endpoint, keyed by the caller's lower-cased email). This data is
/// NEVER put on the wire for any other viewer, NEVER appears in the family overlay (which stays
/// predicted-phases only), and only an AGGREGATE projection of it is ever narrated by the gentle AI note —
/// raw entries (especially <see cref="Intimacy"/>/<see cref="Protected"/>) never reach the model.
///
/// <para>Mirrors the cycle entity conventions: lower-cased <see cref="UserEmail"/> (maxlen 256), a calendar
/// <see cref="LocalDate"/> (DateOnly), timestamptz <see cref="CreatedUtc"/>/<see cref="UpdatedUtc"/>. UNIQUE
/// (UserEmail, LocalDate) — at most one log per day, upserted in place.</para>
/// </summary>
public class CycleDayLog
{
    public int Id { get; set; }

    /// <summary>The owner, stored lower-cased (the identity key; UNIQUE with <see cref="LocalDate"/>).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins.</summary>
    public int UserId { get; set; }

    /// <summary>The calendar day this log is for (the owner's local date). UNIQUE per owner.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>A small mood vocabulary, stored as free text (e.g. happy/calm/irritable/sad/anxious/energized),
    /// or null when not recorded.</summary>
    public string? Mood { get; set; }

    /// <summary>A small symptom vocabulary (e.g. cramps/headache/bloating/fatigue/tender/acne/nausea/backache),
    /// stored as a Postgres <c>text[]</c>. Empty when nothing was logged.</summary>
    public List<string> Symptoms { get; set; } = new();

    /// <summary>The flow level for the day (none by default).</summary>
    public CycleFlowLevel FlowLevel { get; set; } = CycleFlowLevel.None;

    /// <summary>Whether the owner logged intimacy on this day. INTIMATE data — never leaves the owner's reads.</summary>
    public bool Intimacy { get; set; }

    /// <summary>Whether it was protected; only meaningful when <see cref="Intimacy"/> is true (null otherwise).</summary>
    public bool? Protected { get; set; }

    /// <summary>A 1..5 self-rated energy level, or null when not recorded.</summary>
    public int? Energy { get; set; }

    /// <summary>A short free-text note (maxlen 500), or null.</summary>
    public string? Notes { get; set; }

    /// <summary>When this day-log was first created (UTC).</summary>
    public DateTime CreatedUtc { get; set; }

    /// <summary>When this day-log was last updated (UTC) — bumped on every upsert.</summary>
    public DateTime UpdatedUtc { get; set; }
}
