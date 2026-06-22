namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One calendar day of a <see cref="HardChallenge"/>. The row persists ONLY the day-level manual flags
/// (no-alcohol, confession, cheat). The CONFIGURABLE per-task progress (v2) lives on its own
/// <see cref="HardChallengeDayTask"/> child rows; the auto-scored task progress (diet/water/workout) is
/// recomputed LIVE from the tracker on every read and is never persisted here as truth. One row per
/// (UserEmail, LocalDate) — unique.
///
/// <para>V2 NOTE: the v1 fixed task booleans (DietOk/WaterGallonOk/Workout1Ok/Workout2Ok/ReadOk/Workout2Outdoor)
/// and the diet-override are REPLACED by the configurable task model. <c>DietOverride</c> survives as a
/// day-level binary override that the seeded auto "diet" task honours. <c>PhotoTaken</c> is GONE entirely
/// (the column was dropped in the HardChallengeV2 migration) — there is no progress-photo concept in v2.</para>
/// </summary>
public class HardChallengeDay
{
    public long Id { get; set; }

    /// <summary>FK to the owning <see cref="HardChallenge"/> (cascade-deleted with it).</summary>
    public int ChallengeId { get; set; }
    public HardChallenge? Challenge { get; set; }

    /// <summary>Owner email, denormalized + stored lower-cased (unique with <see cref="LocalDate"/>).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The challenge day, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    // ---- Day-level manual override + flags (the ONLY persisted day-level truth) ----

    /// <summary>Manual override of the auto "diet" task result: true/false WINS over the tracker computation;
    /// null = use the live tracker computation. Honoured by the seeded auto-diet task only.</summary>
    public bool? DietOverride { get; set; }

    /// <summary>Cached day points (sum over enabled tasks) — recomputed on read, stored as a denormalized cache.</summary>
    public decimal DayPoints { get; set; }

    /// <summary>Whether the user kept the no-alcohol rule that day. Defaults true. (The seeded no-alcohol task,
    /// when enabled, reads this flag as its binary progress.)</summary>
    public bool NoAlcohol { get; set; } = true;

    /// <summary>Optional Relaxed-ruleset confession (&lt;= 280 chars): keeps the run counted on a missed day.</summary>
    public string? Confession { get; set; }

    /// <summary>Whether this day was pre-declared a cheat day (keeps the run counted without completing).</summary>
    public bool IsCheatDay { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
