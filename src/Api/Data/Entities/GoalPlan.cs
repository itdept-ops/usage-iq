namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A DATED snapshot of one user's calorie/macro goal. The ACTIVE plan for a local date D is the row with
/// the greatest <see cref="EffectiveFrom"/> &lt;= D for that user; TODAY uses the latest plan. Saving the
/// goal/profile creates a new plan effective today only when a target changed (upsert per (user, today)).
/// Keyed by lower-cased <see cref="UserEmail"/>; unique per (UserEmail, EffectiveFrom).
/// </summary>
public class GoalPlan
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased (matches TrackerProfile.UserEmail / FoodEntry.UserEmail).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The LOCAL date (display-tz) from which this plan applies. Unique per user.</summary>
    public DateOnly EffectiveFrom { get; set; }

    // ---- the TARGETS this plan scores a day against (the goal snapshot) ----
    public TrackerGoal Goal { get; set; } = TrackerGoal.Maintain;
    /// <summary>Signed pace kg/wk at the time (display only; null ⇒ goal default). Snapshot of profile.WeeklyRateKg.</summary>
    public double? WeeklyRateKg { get; set; }
    public int? DailyCalorieGoal { get; set; }
    public int? ProteinGoalG { get; set; }
    public int? CarbGoalG { get; set; }
    public int? FatGoalG { get; set; }

    // ---- key INPUTS snapshotted for display in the plan-history list (NOT calc inputs for scoring) ----
    public double? WeightKg { get; set; }
    public double? BodyFatPct { get; set; }
    public ActivityLevel ActivityLevel { get; set; } = ActivityLevel.Sedentary;
    public DietPattern DietPattern { get; set; } = DietPattern.Balanced;

    /// <summary>When this plan row was created/replaced (audit; also breaks the same-day upsert tie).</summary>
    public DateTime CreatedUtc { get; set; }
}
