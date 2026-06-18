namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One logged workout on a user's local date. May reference a row in <see cref="ExerciseLibrary"/>
/// (so the MET + profile weight can estimate <see cref="CaloriesBurned"/>) or be a free-form manual
/// entry. The activity name is snapshotted onto the row so deleting a library item never blanks a log.
/// Keyed for reads by (UserEmail, LocalDate).
/// </summary>
public class ExerciseEntry
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The day this exercise was logged on, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>Optional FK into <see cref="ExerciseLibrary"/>; null for a manual entry.</summary>
    public int? ExerciseId { get; set; }
    public ExerciseLibrary? Exercise { get; set; }

    public string Name { get; set; } = "";

    public int? DurationMin { get; set; }
    public int CaloriesBurned { get; set; }

    public DateTime CreatedUtc { get; set; }
}
