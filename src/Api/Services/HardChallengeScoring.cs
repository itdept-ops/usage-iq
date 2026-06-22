using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Services;

/// <summary>
/// PURE 75 Hard v2 scoring — no I/O, fully unit-testable. Two responsibilities:
///
/// <list type="bullet">
///   <item>The CONFIGURABLE per-task day scoring: each enabled task has a fraction of completion
///   (<see cref="TaskProgress"/>) and earns points — PARTIAL credit pro-rates
///   (<c>PointValue * min(1, progress/target)</c>, rounded to the nearest 0.5), else all-or-nothing. Auto-source
///   progress (diet/water/workout) is computed against the task's OWN custom target so it stays consistent with
///   the tracker day roll-up. Day points = sum over enabled tasks; a day is COMPLETE when EVERY enabled task is
///   at 100% (the default streak threshold — see <see cref="ScoreDay"/>).</item>
///   <item>The RELAXED streak: a re-derivable fold over the ordered day rows (unchanged from v1). A PAST day
///   that is incomplete AND not a cheat day AND has no confession PAUSES the run (does not advance) but does NOT
///   reset; a confession or a cheat day KEEPS the run counted. Longest = max contiguous kept-run length.</item>
/// </list>
/// </summary>
public static class HardChallengeScoring
{
    /// <summary>One US gallon in millilitres — the DEFAULT water target (the user can edit the task target).</summary>
    public const int WaterGallonMl = 3785;

    /// <summary>The DEFAULT minimum logged-exercise duration (minutes) that counts as a 75-Hard workout.</summary>
    public const int WorkoutMinMinutes = 45;

    /// <summary>The DEFAULT required workout count (two 45-minute workouts).</summary>
    public const int WorkoutTargetCount = 2;

    /// <summary>The DEFAULT reading target (pages).</summary>
    public const int ReadingTargetPages = 10;

    /// <summary>Points rounding granularity: partial points round to the nearest 0.5 (so 3/4 cups @ 10 pts = 7.5).</summary>
    public const decimal PointStep = 0.5m;

    /// <summary>Max points a single task may be worth (the config clamps to this).</summary>
    public const int MaxTaskPoints = 1000;

    // ===================================================================================
    // The tracker-derived inputs to AUTO task progress (mirrors the tracker day roll-up).
    // ===================================================================================

    /// <summary>The tracker facts for one day, used to compute auto task progress.</summary>
    public readonly record struct HardDayInput(
        int CaloriesIn,
        double ProteinG,
        double CarbG,
        double FatG,
        int? CalorieGoal,
        int? ProteinGoalG,
        int? CarbGoalG,
        int? FatGoalG,
        int HydrationMl,
        IReadOnlyList<int> WorkoutDurationsMin,
        bool? DietOverride,
        bool NoAlcohol);

    /// <summary>
    /// AUTO diet result: calories-in is within the daily calorie goal AND within every SET macro goal (an unset
    /// goal is skipped). With NO calorie goal set, diet cannot auto-pass — the user attests via the override. A
    /// non-null <paramref name="dietOverride"/> WINS over the computed result.
    /// </summary>
    public static bool ScoreDiet(
        int caloriesIn, double proteinG, double carbG, double fatG,
        int? calorieGoal, int? proteinGoalG, int? carbGoalG, int? fatGoalG, bool? dietOverride)
    {
        if (dietOverride is { } o) return o;
        if (calorieGoal is not { } cal) return false; // nothing to measure against → not auto-passable
        if (caloriesIn > cal) return false;
        if (proteinGoalG is { } pg && proteinG > pg) return false;
        if (carbGoalG is { } cg && carbG > cg) return false;
        if (fatGoalG is { } fg && fatG > fg) return false;
        return true;
    }

    // ===================================================================================
    // Per-task scoring
    // ===================================================================================

    /// <summary>A scored task: its raw progress fraction (0..1), the earned points, and whether it is complete.</summary>
    public readonly record struct TaskScore(int TaskId, string Key, double Progress, decimal Points, bool Complete);

    /// <summary>
    /// The completion FRACTION (0..1) of a single task against its custom target, drawing auto-source progress
    /// from the tracker <paramref name="input"/> and manual progress from <paramref name="manualValue"/> /
    /// <paramref name="manualDone"/>. A binary task (null target, or a binary auto source) is 0 or 1; a measurable
    /// task is min(1, progress/target).
    /// </summary>
    public static double TaskProgress(HardChallengeTask task, HardDayInput input, decimal? manualValue, bool? manualDone)
    {
        switch (task.AutoSource)
        {
            case HardTaskAutoSource.Diet:
                return ScoreDiet(
                    input.CaloriesIn, input.ProteinG, input.CarbG, input.FatG,
                    input.CalorieGoal, input.ProteinGoalG, input.CarbGoalG, input.FatGoalG, input.DietOverride)
                    ? 1.0 : 0.0;

            case HardTaskAutoSource.NoAlcohol:
                return input.NoAlcohol ? 1.0 : 0.0;

            case HardTaskAutoSource.Water:
            {
                var target = (double)(task.TargetValue ?? WaterGallonMl);
                if (target <= 0) return 1.0;
                return Math.Clamp(input.HydrationMl / target, 0.0, 1.0);
            }

            case HardTaskAutoSource.Workout:
            {
                var min = task.MinMinutes ?? WorkoutMinMinutes;
                var count = input.WorkoutDurationsMin.Count(d => d >= min);
                var target = (double)(task.TargetValue ?? WorkoutTargetCount);
                if (target <= 0) return 1.0;
                return Math.Clamp(count / target, 0.0, 1.0);
            }

            default: // None — manual
            {
                if (task.TargetValue is { } t && t > 0)
                    return Math.Clamp((double)((manualValue ?? 0m) / t), 0.0, 1.0);
                // Binary manual task.
                return (manualDone ?? false) ? 1.0 : 0.0;
            }
        }
    }

    /// <summary>
    /// The POINTS a task earns from its progress fraction:
    /// PartialCredit ⇒ <c>PointValue * min(1, progress)</c> rounded to the nearest <see cref="PointStep"/>;
    /// otherwise all-or-nothing (full points at progress &gt;= 1, else 0). A binary task is always all-or-nothing.
    /// </summary>
    public static decimal TaskPoints(HardChallengeTask task, double progress)
    {
        progress = Math.Clamp(progress, 0.0, 1.0);
        var isMeasurable = task.TargetValue is { } t && t > 0;
        if (task.PartialCredit && isMeasurable)
            return RoundToStep((decimal)progress * task.PointValue);
        return progress >= 1.0 ? task.PointValue : 0m;
    }

    /// <summary>Round to the nearest <see cref="PointStep"/> (banker's-rounding-free, half-up at the step).</summary>
    public static decimal RoundToStep(decimal value)
    {
        var steps = Math.Round(value / PointStep, MidpointRounding.AwayFromZero);
        return steps * PointStep;
    }

    // ===================================================================================
    // Per-day scoring (over a task set)
    // ===================================================================================

    /// <summary>The scored result of a whole day: each enabled task's score, the day points, and completeness.</summary>
    public readonly record struct HardDayScore(
        IReadOnlyList<TaskScore> Tasks, decimal DayPoints, decimal MaxPoints, bool Complete);

    /// <summary>The manual progress for a day, keyed by task id (only manual tasks have entries).</summary>
    public sealed record DayManual(decimal? Value, bool? Done);

    /// <summary>
    /// Score one day over the ENABLED tasks. Each task's progress is computed (auto from <paramref name="input"/>,
    /// manual from <paramref name="manualByTaskId"/>), its points earned, and the day is COMPLETE when EVERY
    /// enabled task is at 100% (the default threshold — partial-credit points still COUNT toward the totals, but a
    /// day only counts as a STREAK day when all enabled tasks are fully done). Disabled tasks are ignored.
    /// </summary>
    public static HardDayScore ScoreDay(
        IReadOnlyList<HardChallengeTask> tasks,
        HardDayInput input,
        IReadOnlyDictionary<int, DayManual> manualByTaskId)
    {
        var scores = new List<TaskScore>();
        decimal dayPoints = 0m, maxPoints = 0m;
        var allComplete = true;
        var anyEnabled = false;

        foreach (var task in tasks)
        {
            if (!task.Enabled) continue;
            anyEnabled = true;

            manualByTaskId.TryGetValue(task.Id, out var manual);
            var progress = TaskProgress(task, input, manual?.Value, manual?.Done);
            var points = TaskPoints(task, progress);
            var complete = progress >= 1.0;

            dayPoints += points;
            maxPoints += task.PointValue;
            if (!complete) allComplete = false;

            scores.Add(new TaskScore(task.Id, task.Key, progress, points, complete));
        }

        // A day with NO enabled tasks is not "complete" (nothing was attempted).
        var dayComplete = anyEnabled && allComplete;
        return new HardDayScore(scores, dayPoints, maxPoints, dayComplete);
    }

    // ===================================================================================
    // Relaxed streak (unchanged from v1)
    // ===================================================================================

    /// <summary>A single past/current day's contribution to the Relaxed streak.</summary>
    public readonly record struct StreakDay(bool Complete, bool IsCheatDay, bool HasConfession);

    /// <summary>The current + longest Relaxed streak over an ordered (oldest-first) run of days.</summary>
    public readonly record struct StreakResult(int CurrentStreak, int LongestStreak);

    /// <summary>
    /// The RELAXED streak fold over <paramref name="days"/> (MUST be oldest-first). COMPLETE, or a CHEAT day, or
    /// a day with a CONFESSION ⇒ the run is KEPT and ADVANCES by one; an incomplete day with no confession and not
    /// a cheat day PAUSES the run (no advance, no reset). The longest streak is the max contiguous kept-run length.
    /// </summary>
    public static StreakResult RelaxedStreak(IReadOnlyList<StreakDay> days)
    {
        int current = 0, longest = 0;
        foreach (var d in days)
        {
            var kept = d.Complete || d.IsCheatDay || d.HasConfession;
            if (kept)
            {
                current += 1;
                if (current > longest) longest = current;
            }
            // else: PAUSE — leave `current` unchanged (no advance, no reset).
        }
        return new StreakResult(current, longest);
    }

    // ===================================================================================
    // Default task set (the classic 75 Hard set MINUS the progress photo)
    // ===================================================================================

    /// <summary>
    /// The DEFAULT v2 task set seeded for a new (or backfilled) challenge: diet (binary, auto), water (measurable,
    /// auto, 1 US gallon), two 45-minute workouts (measurable, auto, count target 2), read 10 pages (measurable,
    /// manual), no-alcohol (binary, manual flag). Each is worth 10 points. The classic photo task is intentionally
    /// ABSENT. The user can then edit targets/points, enable/disable, and add custom tasks.
    /// </summary>
    public static IReadOnlyList<HardChallengeTask> DefaultTaskSet(int challengeId, DateTime now)
    {
        HardChallengeTask T(string key, string label, HardTaskAutoSource src, decimal? target,
            int? minMinutes, string unit, bool partial, int sort) => new()
        {
            ChallengeId = challengeId,
            Key = key,
            Label = label,
            AutoSource = src,
            TargetValue = target,
            MinMinutes = minMinutes,
            Unit = unit,
            PointValue = 10,
            PartialCredit = partial,
            Enabled = true,
            SortOrder = sort,
            CreatedUtc = now,
            UpdatedUtc = now,
        };

        return new List<HardChallengeTask>
        {
            T("diet", "Follow a diet", HardTaskAutoSource.Diet, null, null, "", partial: false, sort: 0),
            T("water", "Drink a gallon of water", HardTaskAutoSource.Water, WaterGallonMl, null, "ml", partial: true, sort: 1),
            T("workout", "Two 45-minute workouts", HardTaskAutoSource.Workout, WorkoutTargetCount, WorkoutMinMinutes, "workouts", partial: true, sort: 2),
            T("reading", "Read 10 pages", HardTaskAutoSource.None, ReadingTargetPages, null, "pages", partial: true, sort: 3),
            T("no-alcohol", "No alcohol", HardTaskAutoSource.NoAlcohol, null, null, "", partial: false, sort: 4),
        };
    }
}
