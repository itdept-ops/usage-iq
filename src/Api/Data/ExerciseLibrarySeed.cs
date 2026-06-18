using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Data;

/// <summary>
/// The starter set of common activities with real MET (metabolic equivalent) values and goal tags,
/// seeded once at startup when the <see cref="ExerciseLibrary"/> table is empty. MET values are drawn
/// from the Compendium of Physical Activities; goal tags pick the <see cref="TrackerGoal"/>s each
/// activity best suits. Ids are left unset (DB-assigned) since this is runtime seeding, not HasData.
/// </summary>
public static class ExerciseLibrarySeed
{
    // Short aliases so the table below stays readable.
    private const string Lose = "LoseWeight";
    private const string Maintain = "Maintain";
    private const string Gain = "GainMuscle";
    private const string Endur = "Endurance";

    public static ExerciseLibrary[] Build() =>
    [
        // ---- Cardio ----
        Ex("Walking (3.5 mph, brisk)", "Cardio", 4.3, Lose, Maintain),
        Ex("Walking (4.5 mph, very brisk)", "Cardio", 5.0, Lose, Maintain, Endur),
        Ex("Hiking", "Cardio", 6.0, Lose, Endur),
        Ex("Jogging (5 mph)", "Cardio", 8.0, Lose, Endur),
        Ex("Running (6 mph, 10 min/mile)", "Cardio", 9.8, Lose, Endur),
        Ex("Running (7.5 mph, 8 min/mile)", "Cardio", 11.8, Lose, Endur),
        Ex("Trail running", "Cardio", 9.0, Lose, Endur),
        Ex("Cycling (12-14 mph, moderate)", "Cardio", 8.0, Lose, Endur),
        Ex("Cycling (16-19 mph, vigorous)", "Cardio", 12.0, Lose, Endur),
        Ex("Stationary cycling (vigorous)", "Cardio", 10.5, Lose, Endur),
        Ex("Swimming (freestyle, moderate)", "Cardio", 8.3, Lose, Endur, Maintain),
        Ex("Swimming (freestyle, vigorous)", "Cardio", 9.8, Lose, Endur),
        Ex("Rowing machine (moderate)", "Cardio", 7.0, Lose, Endur, Gain),
        Ex("Rowing machine (vigorous)", "Cardio", 8.5, Lose, Endur),
        Ex("Elliptical trainer", "Cardio", 5.0, Lose, Maintain),
        Ex("Stair climbing (machine)", "Cardio", 9.0, Lose, Endur),
        Ex("Jump rope", "Cardio", 12.3, Lose, Endur),
        Ex("HIIT (high-intensity intervals)", "Cardio", 8.0, Lose, Endur),
        Ex("Aerobics (general)", "Cardio", 7.3, Lose, Maintain),
        Ex("Spinning class", "Cardio", 8.5, Lose, Endur),
        Ex("Skipping / agility drills", "Cardio", 8.0, Lose, Endur),

        // ---- Strength ----
        Ex("Weightlifting (general)", "Strength", 6.0, Gain, Maintain),
        Ex("Weightlifting (vigorous, powerlifting)", "Strength", 8.0, Gain),
        Ex("Bodyweight circuit", "Strength", 5.0, Gain, Lose, Maintain),
        Ex("Push-ups / sit-ups / pull-ups", "Strength", 3.8, Gain, Maintain),
        Ex("Kettlebell training", "Strength", 9.8, Gain, Lose),
        Ex("CrossFit / WOD", "Strength", 8.0, Gain, Lose, Endur),
        Ex("Resistance band workout", "Strength", 3.5, Gain, Maintain),
        Ex("Calisthenics (vigorous)", "Strength", 8.0, Gain, Lose),
        Ex("Core / abdominal workout", "Strength", 4.0, Gain, Maintain),

        // ---- Flexibility / Mind-body ----
        Ex("Yoga (Hatha)", "Flexibility", 2.5, Maintain),
        Ex("Yoga (Power / Vinyasa)", "Flexibility", 4.0, Maintain, Lose),
        Ex("Pilates", "Flexibility", 3.0, Maintain, Gain),
        Ex("Stretching / mobility", "Flexibility", 2.3, Maintain),
        Ex("Tai chi", "Flexibility", 3.0, Maintain),
        Ex("Barre", "Flexibility", 3.5, Maintain, Gain),

        // ---- Sports ----
        Ex("Basketball (game)", "Sports", 8.0, Lose, Endur),
        Ex("Soccer (casual)", "Sports", 7.0, Lose, Endur),
        Ex("Soccer (competitive)", "Sports", 10.0, Lose, Endur),
        Ex("Tennis (singles)", "Sports", 8.0, Lose, Endur),
        Ex("Tennis (doubles)", "Sports", 6.0, Maintain, Lose),
        Ex("Volleyball", "Sports", 4.0, Maintain),
        Ex("Badminton", "Sports", 5.5, Maintain, Lose),
        Ex("Table tennis", "Sports", 4.0, Maintain),
        Ex("Boxing (sparring)", "Sports", 9.0, Lose, Endur),
        Ex("Boxing (heavy bag)", "Sports", 7.8, Lose, Endur, Gain),
        Ex("Martial arts", "Sports", 10.3, Lose, Endur),
        Ex("Golf (walking, carrying clubs)", "Sports", 4.3, Maintain),
        Ex("Rock climbing", "Sports", 8.0, Gain, Endur),
        Ex("Skiing (downhill, moderate)", "Sports", 6.0, Maintain, Endur),
        Ex("Cross-country skiing", "Sports", 9.0, Lose, Endur),
        Ex("Ice skating", "Sports", 7.0, Lose, Endur),

        // ---- Recreation / Daily ----
        Ex("Dancing (general)", "Recreation", 5.0, Lose, Maintain),
        Ex("Dancing (aerobic, fast)", "Recreation", 7.8, Lose, Endur),
        Ex("Gardening", "Recreation", 3.8, Maintain),
        Ex("Housework (heavy cleaning)", "Recreation", 3.5, Maintain),
        Ex("Kayaking / canoeing", "Recreation", 5.0, Maintain, Endur),
        Ex("Surfing", "Recreation", 5.0, Maintain, Endur),
    ];

    private static ExerciseLibrary Ex(string name, string category, double met, params string[] goals) => new()
    {
        Name = name,
        Category = category,
        Met = met,
        GoalTags = string.Join(",", goals),
    };
}
