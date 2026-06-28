using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;

namespace Ccusage.Api.Services;

/// <summary>
/// Pure, side-effect-free computation of a user's body-metric estimates (age, BMI, BMR, TDEE, and the
/// suggested calorie + macro targets) from their current <see cref="TrackerProfile"/>. Everything is
/// metric (kg + cm). Any field whose inputs are missing stays null — partial stats are intended (e.g.
/// BMI without BMR when sex is Unspecified, or nothing at all when height is missing).
///
/// Every input below the original gate (weight + height + age + sex + goal) is OPTIONAL and nullable;
/// when none of the new fields are supplied the result collapses to a sensible goal-based default (never
/// NaN / negative / throw). This MUST stay numerically identical to the TS mirror in
/// <c>src/Web/src/app/features/tracker/units.ts</c> (same constants, same banker's rounding, same order).
///
/// Formulas (metric):
/// <list type="bullet">
///   <item>Age = whole years from DateOfBirth to <c>today</c>.</item>
///   <item>BMI = kg / (cm/100)^2, 1dp. Category: &lt;18.5 Underweight, &lt;25 Normal, &lt;30 Overweight, else Obese.</item>
///   <item>BMR — Katch-McArdle when BodyFatPct is known: LBM = kg·(1 − bf/100); BMR = 370 + 21.6·LBM.
///   Otherwise Mifflin-St Jeor (needs weight+height+age+sex): Male = 10·kg + 6.25·cm − 5·age + 5;
///   Female = 10·kg + 6.25·cm − 5·age − 161.</item>
///   <item>TDEE = BMR · activity factor (Sedentary 1.2, Light 1.375, Moderate 1.55, Active 1.725, VeryActive 1.9).</item>
///   <item>Suggested calories = TDEE + dailyDelta, where dailyDelta = weeklyRateKg·7700/7 and weeklyRateKg is
///   the signed profile pace, or a goal default when null (Lose −0.5, Gain +0.25, else 0 kg/wk). Guardrails,
///   IN ORDER: (a) Pregnant/Breastfeeding force dailyDelta ≥ 0 and add a maintenance increment (Pregnant
///   +340 in T2 / +450 in T3, Breastfeeding +400); (b) deficit capped at the more conservative of −25%·TDEE
///   and −1100 kcal/day (≈ −1.0 kg/wk); (c) never below BMR.</item>
///   <item>Suggested macros (needs weight + a calorie target — the suggestion, else DailyCalorieGoal):
///   protein is lean-mass-anchored when BodyFatPct is known or ProteinBasis=PerLeanMass (≈2.2 g/kg LBM on a
///   cut … 1.6 maintain), else goal-varying per-bodyweight (Lose 2.0 / Gain 1.8 / Maintain 1.6 / Endurance
///   1.4); fat FLOOR = max(0.6·kg, 0.20·cal/9) computed BEFORE carbs; carbs = remainder (cal − p·4 − f·9)/4
///   floored at 0; then DietPattern reshapes the split deterministically (Keto → hard carb floor, remainder
///   to fat; LowCarb → reduced carb cap; others pass through).</item>
/// </list>
/// </summary>
public static class TrackerStats
{
    /// <summary>The calorie/macro targets a day is SCORED against — the active plan's, else the profile fallback.</summary>
    public readonly record struct GoalTargets(
        TrackerGoal Goal, int? DailyCalorieGoal, int? ProteinGoalG, int? CarbGoalG, int? FatGoalG);

    /// <summary>The graceful fallback when no GoalPlan exists for the date: the live profile's current targets
    /// (exactly the behavior before dated plans existed). A null profile reads as Maintain / no goals.</summary>
    public static GoalTargets TargetsFromProfile(TrackerProfile? p) => new(
        p?.Goal ?? TrackerGoal.Maintain,
        p?.DailyCalorieGoal, p?.ProteinGoalG, p?.CarbGoalG, p?.FatGoalG);

    /// <summary>The targets to score a day against when a plan IS active on that date — the plan's snapshot.</summary>
    public static GoalTargets TargetsFromPlan(GoalPlan plan) => new(
        plan.Goal, plan.DailyCalorieGoal, plan.ProteinGoalG, plan.CarbGoalG, plan.FatGoalG);

    /// <summary>Activity multiplier applied to BMR to get TDEE.</summary>
    public static double ActivityFactor(ActivityLevel level) => level switch
    {
        ActivityLevel.Sedentary => 1.2,
        ActivityLevel.Light => 1.375,
        ActivityLevel.Moderate => 1.55,
        ActivityLevel.Active => 1.725,
        ActivityLevel.VeryActive => 1.9,
        _ => 1.2,
    };

    /// <summary>Whole years from <paramref name="dob"/> to <paramref name="today"/> (null if no DOB or future).</summary>
    public static int? AgeFrom(DateOnly? dob, DateOnly today)
    {
        if (dob is not { } d || d > today) return null;
        var age = today.Year - d.Year;
        if (today < d.AddYears(age)) age--; // birthday not yet reached this year
        return age < 0 ? null : age;
    }

    /// <summary>BMI category band for a rounded BMI value.</summary>
    public static string CategoryFor(double bmi) =>
        bmi < 18.5 ? "Underweight"
        : bmi < 25 ? "Normal"
        : bmi < 30 ? "Overweight"
        : "Obese";

    /// <summary>Compute the stats for a profile as of <paramref name="today"/> (display-timezone date).</summary>
    public static TrackerStatsDto Compute(TrackerProfile p, DateOnly today)
    {
        var dto = new TrackerStatsDto();

        var weight = p.WeightKg is { } w && w > 0 ? w : (double?)null;
        var height = p.HeightCm is { } h && h > 0 ? h : (double?)null;
        var age = AgeFrom(p.DateOfBirth, today);
        dto.Age = age;

        // --- BMI (needs weight + height) ---
        if (weight is { } kg && height is { } cm)
        {
            var m = cm / 100.0;
            var bmi = Math.Round(kg / (m * m), 1);
            dto.Bmi = bmi;
            dto.BmiCategory = CategoryFor(bmi);
        }

        // --- BMR — Katch-McArdle when body-fat % is known, else Mifflin-St Jeor ---
        int? bmr = null;
        if (weight is { } kkg && p.BodyFatPct is { } bf && bf > 0 && bf < 100)
        {
            // Katch-McArdle: BMR = 370 + 21.6·LBM, LBM = kg·(1 − bf/100). Needs only weight + body-fat.
            var lbm = kkg * (1 - bf / 100.0);
            bmr = (int)Math.Round(370 + 21.6 * lbm);
            dto.Bmr = bmr;
        }
        else if (weight is { } bkg && height is { } bcm && age is { } a && p.Sex != BiologicalSex.Unspecified)
        {
            // Mifflin-St Jeor: needs weight + height + age + a known sex.
            var raw = 10 * bkg + 6.25 * bcm - 5 * a + (p.Sex == BiologicalSex.Male ? 5 : -161);
            bmr = (int)Math.Round(raw);
            dto.Bmr = bmr;
        }

        // --- TDEE (needs BMR) ---
        int? tdee = null;
        if (bmr is { } b)
        {
            tdee = (int)Math.Round(b * ActivityFactor(p.ActivityLevel));
            dto.Tdee = tdee;
        }

        // --- Suggested calorie goal (rate-based; needs TDEE + BMR) ---
        int? suggested = null;
        if (tdee is { } t && bmr is { } bmrV)
        {
            // Effective signed pace: the user's WeeklyRateKg, else a goal-based default.
            var goalDefault = p.Goal switch
            {
                TrackerGoal.LoseWeight => -0.5,
                TrackerGoal.GainMuscle => 0.25,
                _ => 0.0, // Maintain + Endurance
            };
            var weeklyRateKg = p.WeeklyRateKg ?? goalDefault;

            // ~7700 kcal per kg of body mass; daily delta from the weekly pace.
            var dailyDelta = weeklyRateKg * 7700.0 / 7.0;

            // (a) Pregnant / Breastfeeding: never a deficit; add the standard maintenance increment.
            if (p.LifeStage == LifeStage.Pregnant)
            {
                if (dailyDelta < 0) dailyDelta = 0;
                // T1 ≈ +0; T2 ≈ +340; T3 ≈ +450. Unknown trimester ⇒ the 2nd-trimester figure.
                var increment = p.Trimester switch
                {
                    1 => 0.0,
                    3 => 450.0,
                    _ => 340.0,
                };
                dailyDelta += increment;
            }
            else if (p.LifeStage == LifeStage.Breastfeeding)
            {
                if (dailyDelta < 0) dailyDelta = 0;
                dailyDelta += 400.0;
            }
            else if (dailyDelta < 0)
            {
                // (b) Deficit cap: the more conservative (smaller magnitude) of −25%·TDEE and −1.0 kg/wk.
                var capByPct = -0.25 * t;
                const double capByRate = -1100.0; // ≈ −1.0 kg/wk
                var floorDelta = Math.Max(capByPct, capByRate); // the less-negative of the two
                if (dailyDelta < floorDelta) dailyDelta = floorDelta;
            }

            var raw = (int)Math.Round(t + dailyDelta);
            // (c) Never below BMR.
            suggested = Math.Max(raw, bmrV);
            dto.SuggestedCalorieGoal = suggested;
        }

        // --- Suggested macros (needs weight + a calorie target: the suggestion, else the set goal) ---
        var calorieTarget = suggested ?? p.DailyCalorieGoal;
        if (weight is { } mkg && calorieTarget is { } cal && cal > 0)
        {
            // PROTEIN: lean-mass-anchored when body-fat is known or PerLeanMass is requested; else per-bodyweight.
            var endurance = p.TrainingType == TrainingType.Endurance || p.Goal == TrackerGoal.Endurance;
            double proteinG;
            var useLeanMass = (p.BodyFatPct is { } bfp && bfp > 0 && bfp < 100) || p.ProteinBasis == ProteinBasis.PerLeanMass;
            if (useLeanMass && p.BodyFatPct is { } bf2 && bf2 > 0 && bf2 < 100)
            {
                var lbm = mkg * (1 - bf2 / 100.0);
                // ~2.2 g/kg LBM on a cut, ~1.8 to gain, ~1.6 maintain; endurance trims to ~1.5.
                var perLbm = endurance ? 1.5
                    : p.Goal switch
                    {
                        TrackerGoal.LoseWeight => 2.2,
                        TrackerGoal.GainMuscle => 1.8,
                        _ => 1.6,
                    };
                proteinG = perLbm * lbm;
            }
            else
            {
                // Goal-varying per-bodyweight; endurance leans lowest.
                var perKg = endurance ? 1.4
                    : p.Goal switch
                    {
                        TrackerGoal.LoseWeight => 2.0,
                        TrackerGoal.GainMuscle => 1.8,
                        _ => 1.6,
                    };
                proteinG = perKg * mkg;
            }
            var protein = (int)Math.Round(proteinG);

            // FAT FLOOR (computed BEFORE carbs): the larger of 0.6 g/kg and 20% of calories.
            var fatFloor = Math.Max(0.6 * mkg, 0.20 * cal / 9.0);
            var fat = (int)Math.Round(fatFloor);

            // CARBS = remainder, never negative.
            var carbs = (int)Math.Round((cal - protein * 4 - fat * 9) / 4.0);
            if (carbs < 0) carbs = 0;

            // --- DietPattern reshaping (deterministic) ---
            (protein, fat, carbs) = ReshapeForDiet(p.DietPattern, cal, mkg, protein, fat, carbs);

            dto.SuggestedProteinG = protein;
            dto.SuggestedFatG = fat;
            dto.SuggestedCarbG = Math.Max(0, carbs);
        }

        return dto;
    }

    // ===================================================================================
    // Recovery score (Sleep & Recovery vertical) — deterministic, compute-only, never persisted.
    // ===================================================================================

    /// <summary>
    /// A day's deterministic RECOVERY readout, fused from last night's sleep, the day's caffeine load, the
    /// day's training load, and macro/calorie adherence. Every field is computed (like the goal/macro stats):
    /// AI only NARRATES this — it never produces the number. <see cref="Score"/> and each sub-score are 0..100
    /// (higher = better recovered); <see cref="Label"/> is a short deterministic band.
    /// </summary>
    public readonly record struct RecoveryStats(
        int Score, int SleepScore, int CaffeineScore, int TrainingScore, int FuelScore, string Label);

    /// <summary>The inputs a recovery score is computed from — a flat, already-resolved snapshot so the scoring
    /// function stays a PURE function of plain numbers (no entity/db types). All counts are for the scored day;
    /// <paramref name="SleepHours"/>/<paramref name="SleepQuality"/> are last night's (the scored day's) values.</summary>
    public readonly record struct RecoveryInputs(
        double SleepHours,          // last night's hours slept (>= 0)
        int SleepQuality,           // last night's quality 1..5 (0 when unrated)
        int CaffeineMg,             // the day's resolved caffeine load in mg (see the endpoint's caffeine source)
        int ExerciseCalories,       // the day's logged-exercise calories burned (training load proxy)
        int ActiveCalories,         // the day's watch active calories (0 when none)
        int CaloriesIn,             // the day's resolved calories in
        int? CalorieGoal);          // the day's calorie goal, or null when none set

    // --- Recovery scoring constants (deterministic weights; all well-commented). ---
    // Sub-score weights into the composite (must sum to 100): sleep dominates, then fuel, caffeine, training.
    private const int RecWeightSleep = 45;
    private const int RecWeightFuel = 25;
    private const int RecWeightCaffeine = 15;
    private const int RecWeightTraining = 15;

    /// <summary>The healthy sleep target (hours) a night is scored against; 7.5h reads as ideal.</summary>
    private const double RecSleepTargetHours = 7.5;

    /// <summary>
    /// Compute a day's deterministic <see cref="RecoveryStats"/> from a resolved <see cref="RecoveryInputs"/>
    /// snapshot. PURE + deterministic + total: no throw, no NaN, every output clamped to its range. Designed to
    /// be called ONLY when the day has a sleep entry (the caller gates that), but it is safe for any input.
    ///
    /// Each sub-score is 0..100 (higher = better recovered), then the composite is their weighted average:
    /// <list type="bullet">
    ///   <item>SLEEP (45%) — fuses duration vs the 7.5h target and self-rated quality (1..5). Duration scores a
    ///   smooth band: full credit in [7,9]h, tapering to 0 by ~3h short or ~2h long; quality contributes a
    ///   0..100 linear map (1→0, 5→100). The two blend 70/30 (duration-led). Unrated quality (0) uses duration only.</item>
    ///   <item>CAFFEINE (15%) — full credit up to 200 mg, then a linear penalty to 0 by 600 mg (caffeine impairs
    ///   recovery/sleep debt at high loads). 0 mg is a perfect 100.</item>
    ///   <item>TRAINING (15%) — a U-shaped load score on total burn (exercise + active): a moderate day (≈300 kcal)
    ///   scores best; total rest scores high-but-not-max (no stimulus), a very hard day (≥1200 kcal) scores lowest
    ///   (accumulated fatigue). Deterministic piecewise-linear.</item>
    ///   <item>FUEL (25%) — calorie adherence vs the goal: full credit within ±10% of goal, tapering to 0 by ±50%.
    ///   With NO goal set (or 0 intake) fuel is a neutral 70 (we can't judge adherence, so we neither reward nor punish).</item>
    /// </list>
    /// The label bands the composite: >=80 "Primed", >=65 "Steady", >=45 "Run down", else "Depleted".
    /// </summary>
    public static RecoveryStats ComputeRecovery(RecoveryInputs i)
    {
        // ---- SLEEP sub-score (duration vs 7.5h target, blended 70/30 with quality) ----
        var hours = i.SleepHours > 0 ? i.SleepHours : 0;
        // Duration band: 100 inside [7,9], linear taper to 0 at 4h (3h short) and at 11h (2h long).
        double durScore;
        if (hours >= 7 && hours <= 9) durScore = 100;
        else if (hours < 7) durScore = Clamp01((hours - 4.0) / 3.0) * 100;   // 4h→0, 7h→100
        else durScore = Clamp01((11.0 - hours) / 2.0) * 100;                  // 9h→100, 11h→0
        // Quality 1..5 → 0..100 linear (1→0, 5→100); 0/unrated => use duration alone.
        double sleepScore;
        if (i.SleepQuality is >= 1 and <= 5)
        {
            var qualScore = (i.SleepQuality - 1) / 4.0 * 100;
            sleepScore = 0.70 * durScore + 0.30 * qualScore;
        }
        else
        {
            sleepScore = durScore;
        }
        var sleep = Clamp100(sleepScore);
        _ = RecSleepTargetHours; // target documents the [7,9] sweet-spot midpoint; kept for clarity.

        // ---- CAFFEINE sub-score (full credit to 200 mg, linear to 0 by 600 mg) ----
        double caffScore;
        var mg = i.CaffeineMg > 0 ? i.CaffeineMg : 0;
        if (mg <= 200) caffScore = 100;
        else caffScore = Clamp01((600.0 - mg) / 400.0) * 100; // 200→100, 600→0
        var caffeine = Clamp100(caffScore);

        // ---- TRAINING sub-score (U-shaped on total burn; ~300 kcal is ideal) ----
        var burn = Math.Max(0, i.ExerciseCalories) + Math.Max(0, i.ActiveCalories);
        double trainScore;
        if (burn <= 300)
            // Rest (0)→80 up to the 300-kcal sweet spot→100. A rest day is good-but-not-perfect.
            trainScore = 80 + Clamp01(burn / 300.0) * 20;
        else
            // Past 300, fatigue accrues: 300→100 down to 1200+→40.
            trainScore = 100 - Clamp01((burn - 300.0) / 900.0) * 60;
        var training = Clamp100(trainScore);

        // ---- FUEL sub-score (calorie adherence vs goal; neutral 70 with no goal) ----
        double fuelScore;
        if (i.CalorieGoal is { } goal && goal > 0 && i.CaloriesIn > 0)
        {
            var ratioOff = Math.Abs(i.CaloriesIn - goal) / (double)goal; // 0 = exact
            // Full credit within ±10%; linear to 0 by ±50% off.
            if (ratioOff <= 0.10) fuelScore = 100;
            else fuelScore = Clamp01((0.50 - ratioOff) / 0.40) * 100; // 10%→100, 50%→0
        }
        else
        {
            fuelScore = 70; // can't judge adherence — neutral, neither reward nor punish.
        }
        var fuel = Clamp100(fuelScore);

        // ---- Composite (weighted average; weights sum to 100) ----
        var composite = (int)Math.Round(
            (sleep * RecWeightSleep
             + fuel * RecWeightFuel
             + caffeine * RecWeightCaffeine
             + training * RecWeightTraining) / 100.0);
        composite = Math.Clamp(composite, 0, 100);

        var label = composite >= 80 ? "Primed"
            : composite >= 65 ? "Steady"
            : composite >= 45 ? "Run down"
            : "Depleted";

        return new RecoveryStats(composite, sleep, caffeine, training, fuel, label);
    }

    /// <summary>Clamp a real to [0,1] (NaN/Infinity coerced to 0).</summary>
    private static double Clamp01(double v) => double.IsFinite(v) ? Math.Clamp(v, 0.0, 1.0) : 0.0;

    /// <summary>Round + clamp a 0..100 sub-score to an int in [0,100] (NaN coerced to 0).</summary>
    private static int Clamp100(double v) =>
        double.IsFinite(v) ? Math.Clamp((int)Math.Round(v), 0, 100) : 0;

    /// <summary>
    /// Deterministically reshape a (protein, fat, carb) gram split for a <see cref="DietPattern"/>. Protein is
    /// preserved; carbs are clamped to a pattern-specific cap (Keto pins them at a ~25 g hard floor) and any
    /// freed calories are moved to fat. Balanced/HighProtein/Vegetarian/Vegan/Mediterranean/Paleo pass through.
    /// </summary>
    private static (int protein, int fat, int carbs) ReshapeForDiet(
        DietPattern pattern, int cal, double weightKg, int protein, int fat, int carbs)
    {
        // The carb ceiling (grams) for the carb-restricting patterns; null ⇒ pass through unchanged.
        int? carbCap = pattern switch
        {
            DietPattern.Keto => 25,                               // hard ketogenic floor/cap
            DietPattern.LowCarb => 100,                           // a reduced carb cap
            _ => null,
        };
        if (carbCap is not { } cap || carbs <= cap) return (protein, fat, carbs);

        var freedCarbGrams = carbs - cap;
        carbs = cap;
        // Move the freed carb calories into fat (4 kcal/g carb -> 9 kcal/g fat).
        fat += (int)Math.Round(freedCarbGrams * 4.0 / 9.0);
        if (carbs < 0) carbs = 0;
        return (protein, fat, carbs);
    }
}
