using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The pure body-metric helper <see cref="TrackerStats"/>: BMI category boundaries (18.5/25/30); the
/// Mifflin-St Jeor BMR for male vs female; TDEE per activity factor; suggested calories per goal; and
/// the partial-stats rule (a missing input nulls only the fields that depend on it).
/// </summary>
public class TrackerStatsTests
{
    private static readonly DateOnly Today = new(2026, 6, 18);

    private static TrackerProfile Profile(
        double? weightKg = null, double? heightCm = null, DateOnly? dob = null,
        BiologicalSex sex = BiologicalSex.Unspecified, ActivityLevel activity = ActivityLevel.Sedentary,
        TrackerGoal goal = TrackerGoal.Maintain, int? dailyGoal = null) => new()
    {
        WeightKg = weightKg,
        HeightCm = heightCm,
        DateOfBirth = dob,
        Sex = sex,
        ActivityLevel = activity,
        Goal = goal,
        DailyCalorieGoal = dailyGoal,
    };

    // ---- Age ----

    [Fact]
    public void Age_is_whole_years_to_today_respecting_birthday()
    {
        // Birthday already passed this year.
        TrackerStats.AgeFrom(new DateOnly(1990, 1, 1), Today).Should().Be(36);
        // Birthday is exactly today.
        TrackerStats.AgeFrom(new DateOnly(1990, 6, 18), Today).Should().Be(36);
        // Birthday not yet reached this year.
        TrackerStats.AgeFrom(new DateOnly(1990, 12, 31), Today).Should().Be(35);
    }

    [Fact]
    public void Age_is_null_for_missing_or_future_dob()
    {
        TrackerStats.AgeFrom(null, Today).Should().BeNull();
        TrackerStats.AgeFrom(new DateOnly(2027, 1, 1), Today).Should().BeNull();
    }

    // ---- BMI + category boundaries (18.5 / 25 / 30) ----

    [Fact]
    public void Bmi_is_weight_over_height_m_squared_rounded_1dp()
    {
        // 80 kg, 180 cm → 80 / 1.8^2 = 24.69 → 24.7.
        var s = TrackerStats.Compute(Profile(weightKg: 80, heightCm: 180), Today);
        s.Bmi.Should().Be(24.7);
        s.BmiCategory.Should().Be("Normal");
    }

    [Theory]
    [InlineData(17.0, "Underweight")] // < 18.5
    [InlineData(18.5, "Normal")]      // boundary is Normal
    [InlineData(24.9, "Normal")]      // < 25
    [InlineData(25.0, "Overweight")]  // boundary is Overweight
    [InlineData(29.9, "Overweight")]  // < 30
    [InlineData(30.0, "Obese")]       // boundary is Obese
    [InlineData(35.0, "Obese")]
    public void Bmi_category_boundaries(double bmi, string expected)
    {
        TrackerStats.CategoryFor(bmi).Should().Be(expected);
    }

    [Fact]
    public void Bmi_category_at_exact_boundaries_via_compute()
    {
        // Height 100 cm (= 1 m) makes BMI == weight in kg, so we can hit exact boundary values.
        TrackerStats.Compute(Profile(weightKg: 18.5, heightCm: 100), Today).BmiCategory.Should().Be("Normal");
        TrackerStats.Compute(Profile(weightKg: 25.0, heightCm: 100), Today).BmiCategory.Should().Be("Overweight");
        TrackerStats.Compute(Profile(weightKg: 30.0, heightCm: 100), Today).BmiCategory.Should().Be("Obese");
    }

    // ---- BMR (Mifflin-St Jeor) male vs female ----

    [Fact]
    public void Bmr_male_vs_female_mifflin_st_jeor()
    {
        // 80 kg, 180 cm, age 36.
        // Male = 10*80 + 6.25*180 - 5*36 + 5 = 800 + 1125 - 180 + 5 = 1750.
        var male = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Male), Today);
        male.Bmr.Should().Be(1750);

        // Female = 10*80 + 6.25*180 - 5*36 - 161 = 800 + 1125 - 180 - 161 = 1584.
        var female = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Female), Today);
        female.Bmr.Should().Be(1584);
    }

    // ---- TDEE per activity factor ----

    [Theory]
    [InlineData(ActivityLevel.Sedentary, 2100)]   // 1750 * 1.2 = 2100
    [InlineData(ActivityLevel.Light, 2406)]        // 1750 * 1.375 = 2406.25 → 2406
    [InlineData(ActivityLevel.Moderate, 2712)]     // 1750 * 1.55 = 2712.5 → 2712 (Math.Round half-to-even)
    [InlineData(ActivityLevel.Active, 3019)]       // 1750 * 1.725 = 3018.75 → 3019
    [InlineData(ActivityLevel.VeryActive, 3325)]   // 1750 * 1.9 = 3325
    public void Tdee_per_activity_factor(ActivityLevel level, int expectedTdee)
    {
        var s = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Male, activity: level),
            Today);
        s.Bmr.Should().Be(1750);
        s.Tdee.Should().Be(expectedTdee);
    }

    // ---- Suggested calories per goal ----

    [Theory]
    [InlineData(TrackerGoal.LoseWeight, 1750)] // default -0.5 kg/wk (-550) → 1550, but floored at BMR 1750
    [InlineData(TrackerGoal.Maintain, 2100)]   // TDEE
    [InlineData(TrackerGoal.GainMuscle, 2375)] // default +0.25 kg/wk (+275) → TDEE + 275
    [InlineData(TrackerGoal.Endurance, 2100)]  // TDEE (no default pace)
    public void Suggested_calories_per_goal(TrackerGoal goal, int expected)
    {
        var s = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Male,
                activity: ActivityLevel.Sedentary, goal: goal),
            Today);
        s.Tdee.Should().Be(2100);
        s.SuggestedCalorieGoal.Should().Be(expected);
    }

    // ---- Suggested macros ----

    [Fact]
    public void Suggested_macros_from_weight_and_calorie_target()
    {
        // 80 kg, Maintain, TDEE 2100 → suggested calories 2100.
        // protein = round(1.6*80) = 128 g (Maintain, per-bodyweight); fat floor = max(0.6*80, 0.20*2100/9) = 48 g;
        // carbs = round((2100 - 128*4 - 48*9)/4) = round((2100 - 512 - 432)/4) = round(1156/4) = 289 g.
        var s = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Male), Today);
        s.SuggestedProteinG.Should().Be(128);
        s.SuggestedFatG.Should().Be(48);
        s.SuggestedCarbG.Should().Be(289);
    }

    [Fact]
    public void Suggested_macros_fall_back_to_daily_goal_when_no_tdee()
    {
        // No height → no BMR/TDEE/suggested-calories, but weight + a set DailyCalorieGoal still drive macros.
        var s = TrackerStats.Compute(Profile(weightKg: 80, dailyGoal: 2000), Today);
        s.Bmr.Should().BeNull();
        s.SuggestedCalorieGoal.Should().BeNull();
        // protein = round(1.6*80) = 128, fat floor = max(0.6*80, 0.20*2000/9) = 48,
        // carbs = round((2000 - 128*4 - 48*9)/4) = round((2000 - 512 - 432)/4) = round(1056/4) = 264.
        s.SuggestedProteinG.Should().Be(128);
        s.SuggestedFatG.Should().Be(48);
        s.SuggestedCarbG.Should().Be(264);
    }

    [Fact]
    public void Suggested_carbs_floor_at_zero()
    {
        // Tiny calorie target vs a heavy weight makes the carb residual negative → floored at 0.
        var s = TrackerStats.Compute(Profile(weightKg: 120, dailyGoal: 1000), Today);
        s.SuggestedCarbG.Should().Be(0);
    }

    // ---- Partial stats: missing inputs null only the dependent fields ----

    [Fact]
    public void Unspecified_sex_gives_bmi_but_no_bmr()
    {
        var s = TrackerStats.Compute(
            Profile(weightKg: 80, heightCm: 180, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Unspecified), Today);
        s.Bmi.Should().Be(24.7);
        s.BmiCategory.Should().Be("Normal");
        s.Bmr.Should().BeNull();
        s.Tdee.Should().BeNull();
        s.SuggestedCalorieGoal.Should().BeNull();
    }

    [Fact]
    public void Missing_height_gives_no_bmi_and_no_bmr()
    {
        var s = TrackerStats.Compute(
            Profile(weightKg: 80, dob: new DateOnly(1990, 1, 1), sex: BiologicalSex.Male), Today);
        s.Bmi.Should().BeNull();
        s.BmiCategory.Should().BeNull();
        s.Bmr.Should().BeNull();
        s.Tdee.Should().BeNull();
        s.SuggestedCalorieGoal.Should().BeNull();
        s.Age.Should().Be(36); // age still derives from DOB alone
    }

    [Fact]
    public void Empty_profile_yields_all_null_stats()
    {
        var s = TrackerStats.Compute(Profile(), Today);
        s.Age.Should().BeNull();
        s.Bmi.Should().BeNull();
        s.Bmr.Should().BeNull();
        s.Tdee.Should().BeNull();
        s.SuggestedCalorieGoal.Should().BeNull();
        s.SuggestedProteinG.Should().BeNull();
        s.SuggestedCarbG.Should().BeNull();
        s.SuggestedFatG.Should().BeNull();
    }

    // ---- Recovery (Sleep & Recovery vertical): deterministic, bounded, well-ordered ----

    private static TrackerStats.RecoveryInputs RecInputs(
        double sleepHours = 8, int sleepQuality = 4, int caffeineMg = 0,
        int exerciseCalories = 200, int activeCalories = 0, int caloriesIn = 2000, int? calorieGoal = 2000)
        => new(sleepHours, sleepQuality, caffeineMg, exerciseCalories, activeCalories, caloriesIn, calorieGoal);

    [Fact]
    public void Recovery_is_deterministic_and_bounded()
    {
        var a = TrackerStats.ComputeRecovery(RecInputs());
        var b = TrackerStats.ComputeRecovery(RecInputs());
        // Same inputs -> identical output (pure function), every field within range.
        a.Should().Be(b);
        a.Score.Should().BeInRange(0, 100);
        a.SleepScore.Should().BeInRange(0, 100);
        a.CaffeineScore.Should().BeInRange(0, 100);
        a.TrainingScore.Should().BeInRange(0, 100);
        a.FuelScore.Should().BeInRange(0, 100);
        a.Label.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void Recovery_rewards_good_sleep_and_penalises_poor_sleep()
    {
        // 8h, quality-5, no caffeine, moderate training, on-goal fuel = a strong, "Primed"-band score.
        var great = TrackerStats.ComputeRecovery(RecInputs(sleepHours: 8, sleepQuality: 5, exerciseCalories: 300));
        great.Score.Should().BeGreaterThanOrEqualTo(80);
        great.Label.Should().Be("Primed");

        // 4h, quality-1, heavy caffeine, way off-goal fuel = a far lower score.
        var poor = TrackerStats.ComputeRecovery(RecInputs(
            sleepHours: 4, sleepQuality: 1, caffeineMg: 600, exerciseCalories: 1400, caloriesIn: 3500, calorieGoal: 2000));
        poor.Score.Should().BeLessThan(great.Score);
        poor.SleepScore.Should().BeLessThan(great.SleepScore);
    }

    [Fact]
    public void Recovery_caffeine_subscore_is_perfect_under_200mg_and_zero_at_600mg()
    {
        TrackerStats.ComputeRecovery(RecInputs(caffeineMg: 0)).CaffeineScore.Should().Be(100);
        TrackerStats.ComputeRecovery(RecInputs(caffeineMg: 200)).CaffeineScore.Should().Be(100);
        TrackerStats.ComputeRecovery(RecInputs(caffeineMg: 600)).CaffeineScore.Should().Be(0);
    }

    [Fact]
    public void Recovery_fuel_is_neutral_when_no_goal_set()
    {
        var r = TrackerStats.ComputeRecovery(RecInputs(calorieGoal: null));
        r.FuelScore.Should().Be(70);
    }

    [Fact]
    public void Recovery_never_throws_on_extreme_or_zero_inputs()
    {
        var z = TrackerStats.ComputeRecovery(new TrackerStats.RecoveryInputs(0, 0, 0, 0, 0, 0, null));
        z.Score.Should().BeInRange(0, 100);
        var big = TrackerStats.ComputeRecovery(new TrackerStats.RecoveryInputs(24, 5, 9999, 99999, 99999, 99999, 2000));
        big.Score.Should().BeInRange(0, 100);
    }
}
