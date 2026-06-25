namespace Ccusage.Api.Data.Entities;

/// <summary>The fitness objective a user's tracker is oriented around; tags the exercise library too.</summary>
public enum TrackerGoal
{
    LoseWeight = 0,
    Maintain = 1,
    GainMuscle = 2,
    Endurance = 3,
}

/// <summary>
/// The named time-of-day slot a body-weight reading belongs to, so a user can weigh in multiple times
/// per day (e.g. morning AND evening) and get per-slot statistics. <see cref="Unspecified"/> is the
/// back-compat default for readings logged without a slot (and for rows that predate slots).
/// </summary>
public enum WeightSlot
{
    Unspecified = 0,
    Morning = 1,
    Afternoon = 2,
    Evening = 3,
}

/// <summary>Which meal a logged food belongs to, so the day view can group entries.</summary>
public enum MealType
{
    Breakfast = 0,
    Lunch = 1,
    Dinner = 2,
    Snack = 3,
}

/// <summary>
/// Biological sex, used ONLY as an input to the metabolic (BMR/TDEE) estimate. Labelled neutrally
/// "for metabolic estimates" in the UI. <see cref="Unspecified"/> means the user hasn't supplied it,
/// so BMR/TDEE (and anything derived from them) are not computed.
/// </summary>
public enum BiologicalSex
{
    Unspecified = 0,
    Male = 1,
    Female = 2,
}

/// <summary>How active the user is day-to-day; selects the TDEE activity multiplier on top of BMR.</summary>
public enum ActivityLevel
{
    Sedentary = 0,
    Light = 1,
    Moderate = 2,
    Active = 3,
    VeryActive = 4,
}

/// <summary>
/// The user's preferred display units. A DISPLAY preference only — the backend always stores and
/// returns metric (kilograms + centimetres); the client converts for entry/display.
/// </summary>
public enum UnitSystem
{
    Metric = 0,
    Imperial = 1,
}

/// <summary>
/// How a day's watch ACTIVE CALORIES combine with the logged-exercise calorie sum to produce the day's
/// resolved "calories out". <see cref="Add"/> adds the watch total on top of logged exercises; <see
/// cref="Override"/> replaces the logged-exercise sum with the watch total (a watch active-calories
/// figure usually already includes the day's workouts). With no watch entry / no active-calories value,
/// neither applies and calories out is just the logged-exercise sum.
/// </summary>
public enum ActivityCalorieMode
{
    Add = 0,
    Override = 1,
}

/// <summary>
/// A coarse dietary style used (a) as an AI constraint and (b) to deterministically RESHAPE the
/// suggested macro split (e.g. Keto pulls carbs to a hard floor and pushes the remainder to fat).
/// <see cref="Balanced"/> (0) is the back-compat/neutral default and passes the split through unchanged.
/// </summary>
public enum DietPattern
{
    Balanced = 0,
    HighProtein = 1,
    LowCarb = 2,
    Keto = 3,
    Vegetarian = 4,
    Vegan = 5,
    Mediterranean = 6,
    Paleo = 7,
}

/// <summary>
/// The dominant style of training, an input to goal-aware protein selection (Endurance leans lower
/// per-bodyweight). <see cref="None"/> (0) is the neutral default.
/// </summary>
public enum TrainingType
{
    None = 0,
    Strength = 1,
    Endurance = 2,
    Hybrid = 3,
}

/// <summary>
/// Whether protein is anchored to total bodyweight or to lean body mass. Auto-selected to
/// <see cref="PerLeanMass"/> when body-fat % is known. <see cref="PerBodyweight"/> (0) is the default.
/// </summary>
public enum ProteinBasis
{
    PerBodyweight = 0,
    PerLeanMass = 1,
}

/// <summary>
/// A life stage that DISABLES any calorie deficit and adds a standard maintenance increment
/// (pregnancy by trimester, lactation). <see cref="None"/> (0) is the default.
/// </summary>
public enum LifeStage
{
    None = 0,
    Pregnant = 1,
    Breastfeeding = 2,
}

/// <summary>
/// An optional intermittent-fasting eating window — purely an AI cadence hint, never a calc input.
/// <see cref="None"/> (0) is the default. "W16x8" = 16:8, "W18x6" = 18:6, OMAD = one meal a day.
/// </summary>
public enum EatingWindow
{
    None = 0,
    W16x8 = 1,
    W18x6 = 2,
    OMAD = 3,
}
