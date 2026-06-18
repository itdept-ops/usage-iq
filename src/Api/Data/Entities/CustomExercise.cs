namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One of a user's saved "My exercises" — a per-user library auto-built from MANUALLY logged exercises.
/// Each time the user logs a manual exercise (no <c>ExerciseId</c> and no provider source) it is upserted
/// here keyed by (UserEmail, normalized Name): re-logging the same exercise bumps <see cref="UseCount"/>
/// and <see cref="LastUsedUtc"/> and refreshes the snapshot defaults, rather than inserting a duplicate.
///
/// To make that upsert/dedup work with a unique index, <see cref="NameKey"/> holds the trimmed + lower-cased
/// name (the dedup key), while <see cref="Name"/> stores the display text exactly as the user entered it.
/// </summary>
public class CustomExercise
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>Display name, stored as entered (trimmed + capped at 128).</summary>
    public string Name { get; set; } = "";

    /// <summary>Trim + lower-cased name — the dedup key part so case/whitespace variants collapse to one row.</summary>
    public string NameKey { get; set; } = "";

    /// <summary>Last-logged calories burned, used to prefill the manual form on re-pick.</summary>
    public int? DefaultCaloriesBurned { get; set; }

    /// <summary>Last-logged duration (minutes), used to prefill the manual form on re-pick.</summary>
    public int? DefaultDurationMin { get; set; }

    /// <summary>How many times this exercise has been logged (drives the "frequent" ordering).</summary>
    public int UseCount { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime LastUsedUtc { get; set; }
}
