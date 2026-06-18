namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A seeded catalog of common activities with a MET (metabolic equivalent) value used to estimate
/// calories burned, plus a CSV of <see cref="TrackerGoal"/> names the activity suits so the picker can
/// be filtered to the user's goal. Seeded once at startup if the table is empty.
/// </summary>
public class ExerciseLibrary
{
    public int Id { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Grouping label shown in the picker (e.g. "Cardio", "Strength", "Sports").</summary>
    public string Category { get; set; } = "";

    /// <summary>Metabolic equivalent: caloriesBurned ≈ round(MET * weightKg * durationMin/60).</summary>
    public double Met { get; set; }

    /// <summary>CSV of <see cref="TrackerGoal"/> names this activity suits (e.g. "LoseWeight,Endurance").</summary>
    public string GoalTags { get; set; } = "";
}
