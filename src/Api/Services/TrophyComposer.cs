namespace Ccusage.Api.Services;

/// <summary>
/// PURE trophy-wall composer — no I/O, fully unit-testable. Turns a set of already-aggregated owner metrics
/// (<see cref="TrophyInputs"/>) into the badge list the <c>/api/trophies</c> endpoint returns. ALL badges are
/// DERIVED at read time from existing tracker / 75-Hard / bills data — there is no trophy table and no
/// migration; this composer only does the threshold/tier math.
///
/// <para>Each badge has a tier LADDER (e.g. 10/50/100). A tier is EARNED when the measured value is at-or-above
/// its threshold; the current <see cref="TrophyBadge.Tier"/> is the highest earned tier (or "none"); progress to
/// the next unearned tier is a clamped 0..1 fraction (1.0 when every tier is earned). A one-shot badge (the
/// 75-Hard finisher) has a single "complete" tier.</para>
/// </summary>
public static class TrophyComposer
{
    /// <summary>The owner-scoped metrics the composer scores (all already aggregated by the endpoint).</summary>
    public readonly record struct TrophyInputs(
        // Tracker
        int WorkoutsLogged,
        int DaysTracked,
        int HydrationGoalDays,
        int HydrationStreak,
        int WeighIns,
        int CoffeeCups,
        int Supplements,
        // 75 Hard
        bool HasChallenge,
        int HardLongestStreak,
        int HardCompletedDays,
        decimal HardTotalPoints,
        bool HardFinished,
        // Bills
        int BillsSettled);

    /// <summary>One tier on a badge's ladder: its name, threshold, and whether the measured value reached it.</summary>
    public sealed record TrophyTier(string Name, decimal Threshold, bool Earned);

    /// <summary>A composed badge: catalog metadata + the measured value + the earned/locked tier ladder + progress.</summary>
    public sealed record TrophyBadge(
        string Id,
        string Label,
        string Description,
        string Icon,
        string Group,
        decimal Value,
        string Tier,
        bool Earned,
        IReadOnlyList<TrophyTier> Tiers,
        TrophyTier? NextTier,
        double ProgressToNext);

    private const string TierNone = "none";

    // The standard 3-rung ladder names + the one-shot name.
    private static readonly string[] LadderNames = { "bronze", "silver", "gold" };
    private const string OneShotName = "complete";

    /// <summary>
    /// Build the full ordered badge catalog from the measured inputs. Catalog + thresholds live HERE (one place)
    /// so the endpoint stays a thin loader and the math is unit-tested in isolation.
    /// </summary>
    public static IReadOnlyList<TrophyBadge> Compose(TrophyInputs m)
    {
        var badges = new List<TrophyBadge>
        {
            // ---- Tracker ----
            Ladder("workouts", "Workouts Logged", "Log workouts in the tracker.", "dumbbell", "Tracker",
                m.WorkoutsLogged, 10, 50, 100),
            Ladder("days-tracked", "Days Tracked", "Log food or a workout on a day.", "calendar-check", "Tracker",
                m.DaysTracked, 7, 30, 100),
            Ladder("hydration", "Hydration Goal Hits", "Hit your daily hydration goal.", "droplet", "Tracker",
                m.HydrationGoalDays, 5, 25, 75),
            Ladder("hydration-streak", "Hydration Streak", "Hit your hydration goal on consecutive days.", "waves", "Tracker",
                m.HydrationStreak, 3, 7, 30),
            Ladder("weigh-ins", "Weigh-Ins", "Record your weight.", "scale", "Tracker",
                m.WeighIns, 5, 25, 100),
            Ladder("coffee", "Coffee Logged", "Log cups of coffee.", "coffee", "Tracker",
                m.CoffeeCups, 10, 50, 200),
            Ladder("supplements", "Supplements Logged", "Log supplements.", "pill", "Tracker",
                m.Supplements, 10, 50, 200),

            // ---- 75 Hard (all degrade to 0/locked when the user has no challenge) ----
            Ladder("hard-streak", "75-Hard Streak", "Build your longest 75-Hard streak.", "flame", "75 Hard",
                m.HardLongestStreak, 7, 30, 75),
            Ladder("hard-days", "75-Hard Days Complete", "Complete full 75-Hard days.", "check-circle", "75 Hard",
                m.HardCompletedDays, 10, 40, 75),
            Ladder("hard-points", "75-Hard Points", "Earn 75-Hard points.", "star", "75 Hard",
                m.HardTotalPoints, 250, 1000, 3000),
            OneShot("hard-finisher", "75-Hard Finisher", "Complete all 75 days.", "trophy", "75 Hard",
                m.HardFinished, 75),

            // ---- Bills ----
            Ladder("bills-settled", "Bills Settled", "Settle bills in the Bill Splitter.", "receipt", "Bills",
                m.BillsSettled, 1, 5, 20),
        };
        return badges;
    }

    /// <summary>The count of badges with at least one earned tier (the headline "trophies earned" number).</summary>
    public static int EarnedCount(IReadOnlyList<TrophyBadge> badges) => badges.Count(b => b.Earned);

    // ===================================================================================
    // Badge builders
    // ===================================================================================

    /// <summary>A standard 3-rung (bronze/silver/gold) ladder badge scored against ascending thresholds.</summary>
    private static TrophyBadge Ladder(
        string id, string label, string description, string icon, string group,
        decimal value, decimal bronze, decimal silver, decimal gold)
        => Build(id, label, description, icon, group, value,
            new[] { bronze, silver, gold }, LadderNames);

    /// <summary>A one-shot badge: a single "complete" tier earned when <paramref name="done"/> is true.</summary>
    private static TrophyBadge OneShot(
        string id, string label, string description, string icon, string group,
        bool done, decimal threshold)
        => Build(id, label, description, icon, group,
            value: done ? threshold : 0m,
            thresholds: new[] { threshold }, tierNames: new[] { OneShotName });

    /// <summary>
    /// Core tier math: a tier is earned when <paramref name="value"/> &gt;= its threshold; the current tier is the
    /// highest earned; progress to the next unearned tier is value/threshold clamped to 0..1 (1.0 when maxed).
    /// Thresholds MUST be ascending.
    /// </summary>
    private static TrophyBadge Build(
        string id, string label, string description, string icon, string group,
        decimal value, decimal[] thresholds, string[] tierNames)
    {
        var tiers = new List<TrophyTier>(thresholds.Length);
        var highestEarned = TierNone;
        TrophyTier? nextTier = null;

        for (var i = 0; i < thresholds.Length; i++)
        {
            var earned = value >= thresholds[i];
            var tier = new TrophyTier(tierNames[i], thresholds[i], earned);
            tiers.Add(tier);
            if (earned) highestEarned = tierNames[i];
            else if (nextTier is null) nextTier = tier; // the first unearned tier is the next target
        }

        // Progress toward the next unearned tier (0..1). When every tier is earned there is no next tier ⇒ 1.0.
        double progress;
        if (nextTier is null)
            progress = 1.0;
        else if (nextTier.Threshold <= 0)
            progress = value > 0 ? 1.0 : 0.0;
        else
            progress = Math.Clamp((double)value / (double)nextTier.Threshold, 0.0, 1.0);

        return new TrophyBadge(
            id, label, description, icon, group, value,
            highestEarned, highestEarned != TierNone, tiers, nextTier, progress);
    }
}
