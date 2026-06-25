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

    // --- optional goal-builder refinements (all nullable / neutral-default; never required) ---

    /// <summary>Signed desired pace in kg/week (− = lose, + = gain). Null ⇒ a goal-based default pace.</summary>
    public double? WeeklyRateKg { get; set; }

    /// <summary>Body-fat % (≈3..60). When present, enables Katch-McArdle BMR + lean-mass protein.</summary>
    public double? BodyFatPct { get; set; }

    /// <summary>Neck circumference (cm) — a U.S. Navy tape input that can derive <see cref="BodyFatPct"/>.</summary>
    public double? NeckCm { get; set; }

    /// <summary>Waist circumference (cm) — a U.S. Navy tape input.</summary>
    public double? WaistCm { get; set; }

    /// <summary>Hip circumference (cm) — the U.S. Navy tape input used for females only.</summary>
    public double? HipCm { get; set; }

    /// <summary>Coarse dietary style; reshapes the suggested macro split + constrains AI. Default Balanced.</summary>
    public DietPattern DietPattern { get; set; } = DietPattern.Balanced;

    /// <summary>Free-text / CSV dietary restrictions (allergies, dislikes). An AI constraint only — never a calc input.</summary>
    public string? Restrictions { get; set; }

    /// <summary>Dominant training style; an input to goal-aware protein selection. Default None.</summary>
    public TrainingType TrainingType { get; set; } = TrainingType.None;

    /// <summary>Whether protein anchors on bodyweight or lean mass. Auto lean-mass when body-fat known. Default PerBodyweight.</summary>
    public ProteinBasis ProteinBasis { get; set; } = ProteinBasis.PerBodyweight;

    /// <summary>Life stage that disables a deficit + adds a maintenance increment. Default None.</summary>
    public LifeStage LifeStage { get; set; } = LifeStage.None;

    /// <summary>Pregnancy trimester (1..3); only meaningful when <see cref="LifeStage"/> is Pregnant.</summary>
    public int? Trimester { get; set; }

    /// <summary>Preferred meals per day (1..8); an AI cadence hint only.</summary>
    public int? MealsPerDay { get; set; }

    /// <summary>Optional intermittent-fasting eating window; an AI cadence hint only. Default None.</summary>
    public EatingWindow EatingWindow { get; set; } = EatingWindow.None;

    /// <summary>The bodyweight (kg) the currently-saved goal was computed against — the check-in drift basis.</summary>
    public double? GoalBasisWeightKg { get; set; }

    /// <summary>When the goal was last recomputed-and-saved — the check-in staleness basis.</summary>
    public DateTime? BaselineReviewedUtc { get; set; }

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
