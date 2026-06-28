namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A medication's dosing cadence — enough structure to know WHEN a dose is "due" on a given local date,
/// without overbuilding. <see cref="TimesPerDay"/> is the dose count (1..12). <see cref="TimesOfDay"/> is an
/// OPTIONAL list of specific local times (e.g. "08:00", "20:00"); when present its count should match
/// <see cref="TimesPerDay"/> and it drives the per-slot due check, otherwise the day's doses are simply N
/// untimed slots. <see cref="DaysOfWeekMask"/> is a 7-bit mask (bit 0 = Sunday .. bit 6 = Saturday); 0 or 127
/// both mean "every day". This is a STRUCTURED-but-simple cadence — no PRN/tapering/interval logic in v1.
/// </summary>
public sealed class MedicationSchedule
{
    /// <summary>Doses per active day (1..12). The denominator of the day's adherence.</summary>
    public int TimesPerDay { get; set; } = 1;

    /// <summary>Optional specific local times-of-day for each dose (no date). Empty = N untimed slots.</summary>
    public List<TimeOnly> TimesOfDay { get; set; } = new();

    /// <summary>7-bit day-of-week mask (bit 0 = Sunday .. bit 6 = Saturday). 0 or 127 ⇒ every day.</summary>
    public int DaysOfWeekMask { get; set; }
}

/// <summary>
/// The dosage form a medication is taken in (informational; drives only the UI label). Stored as its int.
/// </summary>
public enum MedicationForm
{
    Pill = 0,
    Capsule = 1,
    Tablet = 2,
    Liquid = 3,
    Injection = 4,
    Inhaler = 5,
    Topical = 6,
    Drops = 7,
    Other = 8,
}

/// <summary>
/// One of the owner's medications + its dosing cadence. PRIVATE health data — STRICTLY OWNER-ONLY, mirroring
/// the Sleep/Cycle owner-only patterns: a row exists only because the owner (who holds <c>tracker.self</c>)
/// created it, and ONLY the owner ever reads or writes it (owner-scoped on every endpoint, keyed by the
/// caller's lower-cased email). This data is NEVER surfaced to a coach / family / contact overlay, NEVER
/// appears in the activity feed, and only an AGGREGATE adherence projection is ever narrated by the optional
/// floored AI — raw rows never reach the model. Deactivating is a soft delete (<see cref="Active"/> = false);
/// logs cascade on a hard delete.
/// </summary>
public sealed class Medication
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the scope + identity key.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins.</summary>
    public int UserId { get; set; }

    /// <summary>Display name (e.g. "Lisinopril"); trimmed, &lt;= 120 chars.</summary>
    public string Name { get; set; } = "";

    /// <summary>Free-text dose (e.g. "10 mg", "2 puffs"); trimmed, &lt;= 60 chars.</summary>
    public string Dose { get; set; } = "";

    /// <summary>The structured dosing cadence (persisted as JSON).</summary>
    public MedicationSchedule Schedule { get; set; } = new();

    /// <summary>Optional dosage form (pill/liquid/...); null when unspecified.</summary>
    public MedicationForm? Form { get; set; }

    /// <summary>Optional free-text note; trimmed, &lt;= 300 chars.</summary>
    public string? Notes { get; set; }

    /// <summary>Whether this med is active (a soft delete sets it false; inactive meds drop out of the due list).</summary>
    public bool Active { get; set; } = true;

    /// <summary>The local date the owner started this medication.</summary>
    public DateOnly StartDate { get; set; }

    /// <summary>Optional local end date; null = ongoing.</summary>
    public DateOnly? EndDate { get; set; }

    /// <summary>Whether the MedicationDue reminder agent should nudge for this med. Default OFF (opt-in).</summary>
    public bool RemindersEnabled { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
