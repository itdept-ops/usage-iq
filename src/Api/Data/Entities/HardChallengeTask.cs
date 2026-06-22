namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Where a <see cref="HardChallengeTask"/>'s progress comes from. AUTO sources are recomputed LIVE from the
/// tracker on every read (the user cannot hand-edit them — only a diet OVERRIDE exists); <see cref="None"/> is a
/// purely MANUAL task whose progress is the day's stored value/done. Stored by int so future sources append.
/// </summary>
public enum HardTaskAutoSource
{
    /// <summary>Manual task: progress is the user-entered value/done on the day row (e.g. reading pages, custom).</summary>
    None = 0,

    /// <summary>AUTO: calories-in within the daily calorie goal AND within every SET macro goal (binary; the
    /// day-level <see cref="HardChallengeDay.DietOverride"/> wins). Binary — no target value.</summary>
    Diet = 1,

    /// <summary>AUTO: the day's hydration sum (ml) vs the task's <see cref="HardChallengeTask.TargetValue"/> ml.</summary>
    Water = 2,

    /// <summary>AUTO: the count of logged exercises whose DurationMin &gt;= the task's
    /// <see cref="HardChallengeTask.MinMinutes"/> vs the task's <see cref="HardChallengeTask.TargetValue"/> count.</summary>
    Workout = 3,

    /// <summary>MANUAL but reads the day-level no-alcohol flag as a binary 0/1 progress (kept for the default set).</summary>
    NoAlcohol = 4,
}

/// <summary>
/// One CONFIGURABLE task in a <see cref="HardChallenge"/>'s daily task set (75 Hard v2). Replaces the v1 fixed
/// six booleans: the user assigns the LABEL, the TARGET (water ml / workout count / reading pages / …), the
/// POINTS, whether PARTIAL credit counts, and can ENABLE/DISABLE or ADD custom manual tasks. Auto tasks
/// (<see cref="AutoSource"/> != None) draw their progress live from the tracker against THIS task's custom
/// target; manual tasks store progress on the per-day <see cref="HardChallengeDayTask"/> child.
///
/// <para>The <see cref="Key"/> is a STABLE id within a challenge (diet/water/workout/reading/no-alcohol or
/// custom-N) so day-progress rows survive a label/target edit. Cascade-deleted with the owning challenge.</para>
/// </summary>
public class HardChallengeTask
{
    public int Id { get; set; }

    /// <summary>FK to the owning <see cref="HardChallenge"/> (cascade-deleted with it).</summary>
    public int ChallengeId { get; set; }
    public HardChallenge? Challenge { get; set; }

    /// <summary>Stable id within the challenge (e.g. <c>diet</c>, <c>water</c>, <c>workout</c>, <c>reading</c>,
    /// <c>no-alcohol</c>, or <c>custom-N</c>). Unique per challenge; never changes once created.</summary>
    public string Key { get; set; } = "";

    /// <summary>The user-facing label (e.g. "Drink a gallon of water"). Editable.</summary>
    public string Label { get; set; } = "";

    /// <summary>Where progress comes from (auto = recomputed from the tracker, none = manual).</summary>
    public HardTaskAutoSource AutoSource { get; set; } = HardTaskAutoSource.None;

    /// <summary>The completion target for a MEASURABLE task (water ml / workout count / reading pages), or null
    /// for a BINARY task (done/not-done). Per-person custom — e.g. water 3785, workouts 2, reading 10.</summary>
    public decimal? TargetValue { get; set; }

    /// <summary>For a <see cref="HardTaskAutoSource.Workout"/> task: the minimum logged-exercise duration
    /// (minutes) that counts toward the target count. Default 45. Null/ignored for non-workout tasks.</summary>
    public int? MinMinutes { get; set; }

    /// <summary>The unit label for a measurable task ("ml", "workouts", "pages", …), or "" for binary.</summary>
    public string Unit { get; set; } = "";

    /// <summary>User-assigned points this task is worth when fully complete (clamped 0..1000).</summary>
    public int PointValue { get; set; }

    /// <summary>When true, a measurable task earns PRO-RATED points (PointValue * min(1, progress/target)); when
    /// false it earns all-or-nothing (full points at 100%, else 0). Ignored for a binary task (always all-or-nothing).</summary>
    public bool PartialCredit { get; set; }

    /// <summary>Whether the task is part of the daily set. Disabled tasks earn no points and are not required.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Display + scoring order within the set.</summary>
    public int SortOrder { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}

/// <summary>
/// The MANUAL progress for one (<see cref="HardChallengeTask"/>, day) pair. Only MANUAL tasks
/// (<see cref="HardTaskAutoSource.None"/>) persist here — auto tasks recompute live from the tracker and are
/// never written. A measurable manual task stores <see cref="Value"/> (e.g. pages read); a binary manual task
/// stores <see cref="Done"/>. One row per (UserEmail, LocalDate, TaskId) — unique.
/// </summary>
public class HardChallengeDayTask
{
    public long Id { get; set; }

    /// <summary>FK to the owning <see cref="HardChallenge"/> (cascade-deleted with it).</summary>
    public int ChallengeId { get; set; }

    /// <summary>FK to the <see cref="HardChallengeTask"/> this progress is for (cascade-deleted with it).</summary>
    public int TaskId { get; set; }
    public HardChallengeTask? Task { get; set; }

    /// <summary>Owner email, denormalized + stored lower-cased (unique with LocalDate + TaskId).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The challenge day, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>The entered value for a MEASURABLE manual task (e.g. pages read), or null.</summary>
    public decimal? Value { get; set; }

    /// <summary>The attestation for a BINARY manual task (done/not), or null.</summary>
    public bool? Done { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
