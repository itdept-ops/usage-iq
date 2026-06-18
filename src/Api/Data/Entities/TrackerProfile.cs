namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One user's food &amp; fitness preferences: their goal, weight (used to estimate calories burned),
/// optional daily calorie/macro targets, and whether their tracker is visible to their mutual chat
/// contacts. One row per user keyed by the lower-cased <see cref="UserEmail"/>.
/// </summary>
public class TrackerProfile
{
    public int Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the identity key (unique).</summary>
    public string UserEmail { get; set; } = "";

    public TrackerGoal Goal { get; set; } = TrackerGoal.Maintain;

    /// <summary>Body weight in kilograms; used to estimate calories burned from MET + duration.</summary>
    public double? WeightKg { get; set; }

    public int? DailyCalorieGoal { get; set; }
    public int? ProteinGoalG { get; set; }
    public int? CarbGoalG { get; set; }
    public int? FatGoalG { get; set; }

    /// <summary>When true, the user's mutual chat contacts may view (read-only) this tracker.</summary>
    public bool ShareWithContacts { get; set; }

    public DateTime UpdatedUtc { get; set; }
}
