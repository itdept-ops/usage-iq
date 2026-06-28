namespace Ccusage.Api.Data.Entities;

/// <summary>
/// The adherence status of a single logged dose. Stored as its int. <see cref="Missed"/> is distinct from
/// <see cref="Skipped"/>: skipped = the owner chose not to take it; missed = it lapsed unlogged (informational,
/// never diagnostic).
/// </summary>
public enum MedicationLogStatus
{
    Taken = 0,
    Skipped = 1,
    Missed = 2,
}

/// <summary>
/// One adherence entry for one dose of a <see cref="Medication"/>. Multiple logs per day are allowed for
/// multi-dose meds (one per <see cref="ScheduledSlot"/>). STRICTLY OWNER-ONLY (mirrors the med it belongs to):
/// keyed by the owner's lower-cased email, never shared to anyone, never in the activity feed. Cascades when
/// its parent medication is hard-deleted.
/// </summary>
public sealed class MedicationLog
{
    public long Id { get; set; }

    /// <summary>The medication this log belongs to (FK, cascade delete).</summary>
    public long MedicationId { get; set; }

    /// <summary>Owner email, stored lower-cased; the scope + identity key (matches the med's owner).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's local date this dose was for.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>Which of the day's doses this is (0-based slot index), or null for an untimed single mark.</summary>
    public int? ScheduledSlot { get; set; }

    /// <summary>Taken / Skipped / Missed.</summary>
    public MedicationLogStatus Status { get; set; } = MedicationLogStatus.Taken;

    /// <summary>When the dose was actually taken (UTC), when <see cref="Status"/> is Taken; else null.</summary>
    public DateTime? TakenAtUtc { get; set; }

    /// <summary>Optional free-text note; trimmed, &lt;= 200 chars.</summary>
    public string? Notes { get; set; }

    public DateTime CreatedUtc { get; set; }
}
