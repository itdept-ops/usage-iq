namespace Ccusage.Api.Data.Entities;

/// <summary>The rule set a 75 Hard run follows. Only <see cref="Relaxed"/> exists today: the same six daily
/// tasks as the classic challenge, but a missed day PAUSES the streak (it does not wipe the whole run), and a
/// pre-declared cheat day or a logged confession keeps the run counted. Stored by int so future rulesets append.</summary>
public enum HardRuleset
{
    Relaxed = 0,
}

/// <summary>Lifecycle of a 75 Hard challenge. <see cref="Active"/> is the single in-progress run (the one-active
/// invariant is enforced by a filtered-unique index on UserEmail WHERE Status=0). <see cref="Completed"/> is set
/// when day 75 passes; <see cref="Abandoned"/> is a user-ended run. Stored by int.</summary>
public enum HardChallengeStatus
{
    Active = 0,
    Completed = 1,
    Abandoned = 2,
}

/// <summary>
/// One user's 75 Hard challenge. Gated by the SAME tracker permissions as the food/fitness tracker
/// (<c>tracker.self</c> for own use, <c>tracker.viewall</c> for coach/admin read-all) — there is no dedicated
/// 75-Hard permission; the feature travels with the tracker grant. One row per user keyed by the lower-cased
/// <see cref="UserEmail"/>.
///
/// <para>INVARIANT — one ACTIVE challenge per user: a FILTERED UNIQUE index on (UserEmail) WHERE Status=0
/// (configured with HasFilter) guarantees at most one <see cref="HardChallengeStatus.Active"/> row; the start
/// endpoint also catches the unique violation. The CURRENT DAY (1..75) is DERIVED on read from the display-tz
/// today and <see cref="StartDate"/> — it is NEVER stored.</para>
///
/// <para>The auto-scored daily bits (diet/water/workouts) are recomputed LIVE from the tracker on every read and
/// are never persisted here as truth — only the manual attestations + override live on <see cref="HardChallengeDay"/>.
/// There is deliberately NO image storage anywhere: progress photos are a boolean attestation only.</para>
/// </summary>
public class HardChallenge
{
    public int Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the identity key (one ACTIVE row per user, filtered-unique).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The day the challenge began, in the app's display timezone. Day 1 = this date.</summary>
    public DateOnly StartDate { get; set; }

    public HardRuleset Ruleset { get; set; } = HardRuleset.Relaxed;

    public HardChallengeStatus Status { get; set; } = HardChallengeStatus.Active;

    /// <summary>Cached count of days that fully passed all six tasks (recomputed on read from the day grid).</summary>
    public int CompletedDays { get; set; }

    /// <summary>Cached current Relaxed-streak length (recomputed on read).</summary>
    public int CurrentStreak { get; set; }

    /// <summary>Cached longest contiguous kept-run length over the challenge (recomputed on read).</summary>
    public int LongestStreak { get; set; }

    /// <summary>How many confessions (the Relaxed "keep the run going on a missed day" lever) have been used.</summary>
    public int ConfessionsUsed { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }

    /// <summary>The CONFIGURABLE daily task set (75 Hard v2): the user edits targets/points, enables/disables,
    /// and adds custom manual tasks. Seeded with the default set (classic 75 Hard MINUS the photo) on start.</summary>
    public List<HardChallengeTask> Tasks { get; set; } = new();
}
