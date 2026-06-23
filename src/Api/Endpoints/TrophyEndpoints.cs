using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// The Trophy Wall (<c>/api/trophies</c>): the CALLER's own milestone badges, DERIVED at read time from existing
/// tracker / 75-Hard / bills data. Gated by the SAME <see cref="Permissions.TrackerSelf"/> the tracker, 75-Hard,
/// feed, and automations reuse — there is NO new permission, NO new tracking column, and NO migration.
///
/// <para>V1 is PERSONAL-ONLY (no share variant): the existing dashboard share-links system is purpose-built for
/// usage analytics and the Bill Splitter has its own separate public-token surface — neither cheaply carries a
/// trophy card, so a shareable card is a clean follow-up rather than V1 scope.</para>
///
/// <para>PRIVACY: every query is owner-scoped to the caller's own email; the DTO carries the caller's userId +
/// display NAME only (via <see cref="DisplayName.Format"/>) — NEVER an email. The pure
/// <see cref="TrophyComposer"/> does all threshold/tier math; this endpoint is a thin metric loader.</para>
/// </summary>
public static class TrophyEndpoints
{
    private const int DefaultHydrationGoalMl = 2000;

    /// <summary>One tier on a badge's ladder (name + threshold + earned).</summary>
    public sealed record TierDto(string Name, decimal Threshold, bool Earned);

    /// <summary>One badge: catalog metadata + measured value + earned/locked tier ladder + progress to next.</summary>
    public sealed record BadgeDto(
        string Id, string Label, string Description, string Icon, string Group,
        decimal Value, string Tier, bool Earned,
        IReadOnlyList<TierDto> Tiers, TierDto? NextTier, double ProgressToNext);

    /// <summary>The caller's own trophy wall (userId + display name only — NEVER an email).</summary>
    public sealed record TrophiesResponse(
        int UserId, string UserName, string GeneratedUtc, int EarnedCount, int TotalCount,
        IReadOnlyList<BadgeDto> Badges);

    public static void MapTrophyEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/trophies")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET / : the caller's own trophy wall (self-only; derived; no email) ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var email = caller.Email;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);

            var inputs = await LoadInputsAsync(db, email, today, ct);
            var badges = TrophyComposer.Compose(inputs);

            var owner = await db.Users.AsNoTracking()
                .Where(u => u.Email == email)
                .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname })
                .FirstOrDefaultAsync(ct);

            var resp = new TrophiesResponse(
                owner?.Id ?? 0,
                owner is null ? DisplayName.Unknown : DisplayName.Format(owner.Name, owner.DisplayNameMode, owner.Nickname),
                DateTime.UtcNow.ToString("o"),
                TrophyComposer.EarnedCount(badges),
                badges.Count,
                badges.Select(ToDto).ToList());
            return Results.Ok(resp);
        });
    }

    // =====================================================================================
    // Metric loading (owner-scoped aggregations — the only I/O; the math lives in TrophyComposer)
    // =====================================================================================

    /// <summary>
    /// Load the caller's owner-scoped trophy metrics. Every query filters <c>UserEmail == email</c> (bills by
    /// <c>OwnerEmail</c>) so no other user's data is ever read. 75-Hard stats come from the persisted
    /// <see cref="HardChallenge"/> columns (kept fresh by the owner's own challenge-page reads) — cumulative over
    /// the user's most-recent run, with a finisher flag for any completed run.
    /// </summary>
    private static async Task<TrophyComposer.TrophyInputs> LoadInputsAsync(
        UsageDbContext db, string email, DateOnly today, CancellationToken ct)
    {
        // ---- Tracker simple counts ----
        var workouts = await db.ExerciseEntries.CountAsync(x => x.UserEmail == email, ct);
        var weighIns = await db.WeightEntries.CountAsync(w => w.UserEmail == email, ct);
        var coffeeCups = await db.CoffeeEntries.Where(c => c.UserEmail == email).SumAsync(c => (int?)c.Cups, ct) ?? 0;
        var supplements = await db.SupplementEntries.CountAsync(s => s.UserEmail == email, ct);

        // ---- Days tracked: distinct local dates with food OR exercise activity ----
        var foodDates = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email).Select(f => f.LocalDate).Distinct().ToListAsync(ct);
        var exerciseDates = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email).Select(x => x.LocalDate).Distinct().ToListAsync(ct);
        var daysTracked = foodDates.Concat(exerciseDates).Distinct().Count();

        // ---- Hydration goal hits + streak (per-day sum vs the user's resolved goal) ----
        var goalMl = await db.TrackerProfiles.AsNoTracking()
            .Where(p => p.UserEmail == email).Select(p => p.HydrationGoalMl)
            .FirstOrDefaultAsync(ct) ?? DefaultHydrationGoalMl;
        var hydrationDays = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email)
            .GroupBy(h => h.LocalDate)
            .Select(grp => new { Date = grp.Key, Ml = grp.Sum(h => h.AmountMl) })
            .ToListAsync(ct);
        var qualifyingDays = hydrationDays.Where(d => d.Ml >= goalMl).Select(d => d.Date).ToHashSet();
        var hydrationGoalDays = qualifyingDays.Count;
        var hydrationStreak = ConsecutiveStreakEndingAt(qualifyingDays, today);

        // ---- 75 Hard: persisted cumulative columns over the user's runs ----
        // Longest streak / completed days / points are read from the user's runs; the finisher flag is true when
        // ANY run reached Completed. Total points are re-folded (not persisted) for the active run only — cheap.
        var hardRows = await db.HardChallenges.AsNoTracking()
            .Where(c => c.UserEmail == email)
            .Select(c => new { c.Status, c.CompletedDays, c.LongestStreak })
            .ToListAsync(ct);
        var hasChallenge = hardRows.Count > 0;
        var hardLongestStreak = hardRows.Count == 0 ? 0 : hardRows.Max(r => r.LongestStreak);
        var hardCompletedDays = hardRows.Count == 0 ? 0 : hardRows.Max(r => r.CompletedDays);
        var hardFinished = hardRows.Any(r => r.Status == HardChallengeStatus.Completed);
        var hardTotalPoints = await HardTotalPointsAsync(db, email, today, ct);

        // ---- Bills settled (owner-scoped) ----
        var billsSettled = await db.Bills.CountAsync(b => b.OwnerEmail == email && b.Status == "settled", ct);

        return new TrophyComposer.TrophyInputs(
            WorkoutsLogged: workouts,
            DaysTracked: daysTracked,
            HydrationGoalDays: hydrationGoalDays,
            HydrationStreak: hydrationStreak,
            WeighIns: weighIns,
            CoffeeCups: coffeeCups,
            Supplements: supplements,
            HasChallenge: hasChallenge,
            HardLongestStreak: hardLongestStreak,
            HardCompletedDays: hardCompletedDays,
            HardTotalPoints: hardTotalPoints,
            HardFinished: hardFinished,
            BillsSettled: billsSettled);
    }

    /// <summary>
    /// The cumulative 75-Hard points for the user's ACTIVE run, re-folded with the pure scorer (reuses the same
    /// per-day in-memory scoring the leaderboard/recap use, via <see cref="HardChallengeEndpoints"/>'s public
    /// weekly-recap helper). 0 when there is no active run. The whole-run total = the recap "total points".
    /// </summary>
    private static async Task<decimal> HardTotalPointsAsync(
        UsageDbContext db, string email, DateOnly today, CancellationToken ct)
    {
        // The weekly-recap helper already returns the run-wide TotalPoints; reuse it with a trivial window so we
        // don't duplicate the scorer fold. Null ⇒ no active challenge ⇒ 0 points.
        var stats = await HardChallengeEndpoints.ComputeWeeklyRecapStatsAsync(db, email, today, today, today, ct);
        return stats?.TotalPoints ?? 0m;
    }

    /// <summary>
    /// The length of the consecutive run of qualifying days ending at <paramref name="today"/> (or, if today does
    /// not qualify, ending at yesterday — so an in-progress day that hasn't hit goal yet doesn't break a streak).
    /// PURE set walk over the qualifying-date set.
    /// </summary>
    private static int ConsecutiveStreakEndingAt(HashSet<DateOnly> qualifying, DateOnly today)
    {
        if (qualifying.Count == 0) return 0;
        // Anchor at today if it qualifies, else at yesterday (grace for an unfinished current day).
        var cursor = qualifying.Contains(today) ? today : today.AddDays(-1);
        var streak = 0;
        while (qualifying.Contains(cursor))
        {
            streak++;
            cursor = cursor.AddDays(-1);
        }
        return streak;
    }

    private static BadgeDto ToDto(TrophyComposer.TrophyBadge b) => new(
        b.Id, b.Label, b.Description, b.Icon, b.Group,
        b.Value, b.Tier, b.Earned,
        b.Tiers.Select(t => new TierDto(t.Name, t.Threshold, t.Earned)).ToList(),
        b.NextTier is { } n ? new TierDto(n.Name, n.Threshold, n.Earned) : null,
        b.ProgressToNext);
}
