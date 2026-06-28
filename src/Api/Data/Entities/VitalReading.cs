namespace Ccusage.Api.Data.Entities;

/// <summary>
/// The kind of vital a reading records. Stored as its int. <see cref="BloodPressure"/> is the only two-value
/// kind (systolic in Value1, diastolic in Value2); every other kind uses Value1 only.
/// </summary>
public enum VitalKind
{
    BloodPressure = 0,
    HeartRate = 1,
    Glucose = 2,
    Temperature = 3,
    OxygenSaturation = 4,
    BodyWeight = 5,
}

/// <summary>
/// One vital-sign reading. PRIVATE health data — STRICTLY OWNER-ONLY, mirroring the Sleep/Cycle owner-only
/// patterns: a row exists only because the owner (who holds <c>tracker.self</c>) logged it, and ONLY the owner
/// ever reads or writes it (owner-scoped on every endpoint, keyed by the caller's lower-cased email). NEVER
/// surfaced to a coach / family / contact, NEVER in the activity feed, and only AGGREGATE stats (avg/min/max/
/// trend) ever reach the optional floored AI — raw readings never do.
/// </summary>
public sealed class VitalReading
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the scope + identity key.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins.</summary>
    public int UserId { get; set; }

    /// <summary>Which vital this reading is.</summary>
    public VitalKind Kind { get; set; }

    /// <summary>The primary reading (systolic for BP; the single value for every other kind).</summary>
    public decimal Value1 { get; set; }

    /// <summary>The secondary reading (diastolic for BP); null for single-value kinds.</summary>
    public decimal? Value2 { get; set; }

    /// <summary>The unit the reading is in (e.g. "mmHg", "bpm", "mg/dL", "°F", "%", "lb"); trimmed, &lt;= 16 chars.</summary>
    public string Unit { get; set; } = "";

    /// <summary>The owner's local date this reading is for.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>When the reading was actually measured (UTC); null when only the date was recorded.</summary>
    public DateTime? MeasuredAtUtc { get; set; }

    /// <summary>Optional free-text note; trimmed, &lt;= 200 chars.</summary>
    public string? Notes { get; set; }

    public DateTime CreatedUtc { get; set; }
}
