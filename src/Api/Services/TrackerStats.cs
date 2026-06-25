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
