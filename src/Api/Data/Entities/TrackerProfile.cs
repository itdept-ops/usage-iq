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

    /// <summary>Date of birth; age (whole years to "today") is derived for the metabolic estimate.</summary>
    public DateOnly? DateOfBirth { get; set; }

    /// <summary>Height in centimetres (metric is always stored); an input to BMI + BMR.</summary>
    public double? HeightCm { get; set; }

    /// <summary>Biological sex (for the metabolic estimate). Unspecified ⇒ no BMR/TDEE.</summary>
    public BiologicalSex Sex { get; set; } = BiologicalSex.Unspecified;

    /// <summary>Day-to-day activity level; the TDEE multiplier on top of BMR.</summary>
    public ActivityLevel ActivityLevel { get; set; } = ActivityLevel.Sedentary;

    /// <summary>Target body weight in kilograms, for the weight-trend goal line + progress.</summary>
    public double? GoalWeightKg { get; set; }

    /// <summary>Preferred display units (metric vs imperial). Backend always stores/returns metric.</summary>
    public UnitSystem UnitSystem { get; set; } = UnitSystem.Metric;

    public int? DailyCalorieGoal { get; set; }
    public int? ProteinGoalG { get; set; }
    public int? CarbGoalG { get; set; }
    public int? FatGoalG { get; set; }

    /// <summary>Daily fluid-intake goal in millilitres; null ⇒ the day uses a 2000 ml default.</summary>
    public int? HydrationGoalMl { get; set; }

    /// <summary>Daily coffee CAP in cups; null ⇒ the day uses a 3-cup default. The goal is a limit, not a target.</summary>
    public int? CoffeeGoalCups { get; set; }

    /// <summary>Daily step goal; null ⇒ the UI shows a ~10000 default. Not required.</summary>
    public int? StepGoal { get; set; }

    /// <summary>When true, the user's mutual chat contacts may view (read-only) this tracker.</summary>
    public bool ShareWithContacts { get; set; }

    public DateTime UpdatedUtc { get; set; }
}
