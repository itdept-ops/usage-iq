using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Hub Wrapped (<c>/api/wrapped</c>): the CALLER's own "year in the Hub" story-card recap over a chosen period
/// (this-month / this-year / all-time). EVERY number is DERIVED at read time by REUSING the existing owner-scoped
/// aggregations generalized to the period window — there is NO parallel rollup, NO invented figure, NO migration
/// (all sources read existing tables):
/// <list type="bullet">
///   <item><see cref="WeeklyRecapComposer.LoadStatsAsync"/> — workouts/minutes, calories in/out, protein/day,
///   steps, hydration goal-days, coffee, 75-Hard slice, bills settled (lifetime) over [from,to].</item>
///   <item><see cref="TrophyEndpoints.LoadInputsAsync"/> + <see cref="TrophyComposer"/> — lifetime trophies earned.</item>
///   <item><see cref="UsageQueries.SummaryAsync"/> scoped to <c>ReportedByUser == email</c> — usage cost/tokens/requests.</item>
/// </list>
/// Plus a few owner-scoped window reads the recap composer doesn't expose (days-tracked, hydration best streak,
/// weight delta, sleep avg) — each mirrors an existing pattern, never a new rollup.
///
/// <para>Gated by the SAME <see cref="Permissions.TrackerSelf"/> the tracker / trophies / 75-Hard reuse — no new
/// permission, no migration. PRIVACY: every query is owner-scoped to the caller's own email (tracker/75-Hard/bills
/// by <c>UserEmail</c>/<c>OwnerEmail</c>; usage by <c>ReportedByUser</c>); the DTO carries the caller's userId +
/// display NAME only (via <see cref="DisplayName.Format"/>) — NEVER an email, never a secret.</para>
/// </summary>
public static class WrappedEndpoints
{
    private const int DefaultHydrationGoalMl = 2000;

    /// <summary>The 75-Hard slice of a Wrapped period (null when the caller has no ACTIVE challenge).</summary>
    public sealed record HardSlice(int CurrentStreak, decimal TotalPoints, decimal WeekPoints, int CompletedDays);

    /// <summary>One story card: a stable key, the big headline value, a label, optional sub-line + accent hint.</summary>
    public sealed record WrappedCard(string Key, string Headline, string Label, string? Sub, string? Accent);

    /// <summary>
    /// The caller's own Wrapped for a period. <c>Cards</c> is the display story (0-valued cards are dropped, mirroring
    /// the recap's conditional fields); the structured fields below back the frontend (charts/share) without re-deriving.
    /// userId + display NAME only — NEVER an email.
    /// </summary>
    public sealed record WrappedResponse(
        int UserId, string UserName, string Period, string FromDate, string ToDate, string GeneratedUtc,
        IReadOnlyList<WrappedCard> Cards,
        // ---- structured extras (same numbers as the cards, for the frontend) ----
        int DaysTracked, int Workouts, int WorkoutMinutes,
        int CaloriesInTotal, int CaloriesOutTotal, double ProteinAvgG, long StepsTotal,
        int HydrationGoalHits, int HydrationDays, int HydrationBestStreak,
        int CoffeeCups, double? WeightDeltaKg, double? SleepAvgHours,
        HardSlice? Hard,
        int TrophiesEarned, int TrophiesTotal,   // lifetime (trophies are cumulative by design)
        int BillsSettled,                        // lifetime (bills have no settled timestamp)
        decimal UsageCostUsd, long UsageTokens, int UsageRequests);

    public static void MapWrappedEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/wrapped")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET /?period=month|year|all : the caller's own Wrapped (self-only; derived; no email) ----
        g.MapGet("/", async (string? period, CurrentUserAccessor me, UsageDbContext db,
            UsageQueries usage, WeeklyRecapComposer recap, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var (norm, from, to) = ResolveWindow(period, today);
            var resp = await BuildWrappedAsync(db, usage, recap, caller.Email, norm, from, to, ct);
            return Results.Ok(resp);
        });
    }

    /// <summary>
    /// Build the DERIVED <see cref="WrappedResponse"/> for an arbitrary OWNER email over [from,to]. EVERY number
    /// is computed SERVER-SIDE by reusing the same owner-scoped aggregations the caller's own Wrapped uses — so
    /// the public-share path can rebuild a recap from a BAKED owner+window the holder can never widen. Nothing
    /// here comes from any client. No email is ever placed in the response (owner is resolved to a display NAME).
    /// </summary>
    internal static async Task<WrappedResponse> BuildWrappedAsync(
        UsageDbContext db, UsageQueries usage, WeeklyRecapComposer recap,
        string email, string norm, DateOnly from, DateOnly to, CancellationToken ct)
    {
        // (1) Tracker totals over the window — REUSE the recap composer (same numbers as the rest of the app).
        var stats = await recap.LoadStatsAsync(db, email, from, to, to, ct);

        // ---- Gaps the composer doesn't expose, as owner-scoped WINDOW reads (mirror existing patterns) ----
        var (daysTracked, hydrationDays, hydrationBestStreak, weightDeltaKg, sleepAvgHours) =
            await LoadWindowExtrasAsync(db, email, from, to, ct);

        // (2) Trophies earned — LIFETIME/cumulative by design; reuse the trophy loader + composer.
        var inputs = await TrophyEndpoints.LoadInputsAsync(db, email, to, ct);
        var badges = TrophyComposer.Compose(inputs);
        var trophiesEarned = TrophyComposer.EarnedCount(badges);

        // (3) Usage cost/tokens/requests over the window — REUSE the summary, scoped to the owner's reported email.
        var usageFilter = new UsageFilterQuery(from: from, to: to, projectId: null, model: null, source: null,
            includeSidechain: null, machine: null, user: new[] { email });
        var usageTotal = (await usage.SummaryAsync(usageFilter, "model", ct)).Total;

        var owner = await db.Users.AsNoTracking()
            .Where(u => u.Email == email)
            .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname })
            .FirstOrDefaultAsync(ct);

        var hard = stats.Hard is { } h
            ? new HardSlice(h.CurrentStreak, h.TotalPoints, h.WeekPoints, h.WeekCompletedDays)
            : null;

        var cards = BuildCards(stats, daysTracked, hydrationDays, hydrationBestStreak, weightDeltaKg,
            sleepAvgHours, hard, trophiesEarned, badges.Count, usageTotal);

        return new WrappedResponse(
            owner?.Id ?? 0,
            owner is null ? DisplayName.Unknown : DisplayName.Format(owner.Name, owner.DisplayNameMode, owner.Nickname),
            norm, from.ToString("yyyy-MM-dd"), to.ToString("yyyy-MM-dd"), DateTime.UtcNow.ToString("o"),
            cards,
            daysTracked, stats.Workouts, stats.WorkoutMinutes,
            stats.CaloriesInTotal, stats.CaloriesOutTotal, stats.ProteinAvgG, stats.StepsTotal,
            stats.HydrationGoalHits, hydrationDays, hydrationBestStreak,
            stats.CoffeeCups, weightDeltaKg, sleepAvgHours,
            hard,
            trophiesEarned, badges.Count,
            stats.BillsSettled,
            usageTotal.CostUsd, usageTotal.TotalTokens, usageTotal.Records);
    }

    /// <summary>
    /// Normalize the period query into the inclusive window [from, to] (to = today in the display tz). Unknown /
    /// missing input defaults to <c>month</c>. all-time uses <see cref="DateOnly.MinValue"/> as the open start so
    /// every reusable aggregation (which all take an explicit from/to) widens to the user's whole history.
    /// </summary>
    internal static (string Period, DateOnly From, DateOnly To) ResolveWindow(string? period, DateOnly today)
    {
        switch ((period ?? "month").Trim().ToLowerInvariant())
        {
            case "year":
                return ("year", new DateOnly(today.Year, 1, 1), today);
            case "all":
            case "all-time":
            case "alltime":
                return ("all", DateOnly.MinValue, today);
            case "month":
            default:
                return ("month", new DateOnly(today.Year, today.Month, 1), today);
        }
    }

    /// <summary>
    /// The window-scoped metrics the recap composer doesn't expose, each owner-scoped to the caller and mirroring an
    /// existing pattern (no new rollup): days-tracked = distinct food∪exercise dates (TrophyEndpoints lines 92-96 +
    /// a date filter); hydration goal-days + BEST consecutive streak in-window (longest run over the qualifying set);
    /// weight delta = last-minus-first reading in the window; sleep avg = mean hours over the window.
    /// </summary>
    private static async Task<(int DaysTracked, int HydrationDays, int HydrationBestStreak, double? WeightDeltaKg, double? SleepAvgHours)>
        LoadWindowExtrasAsync(UsageDbContext db, string email, DateOnly from, DateOnly to, CancellationToken ct)
    {
        var foodDates = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate >= from && f.LocalDate <= to)
            .Select(f => f.LocalDate).Distinct().ToListAsync(ct);
        var exerciseDates = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate >= from && x.LocalDate <= to)
            .Select(x => x.LocalDate).Distinct().ToListAsync(ct);
        var daysTracked = foodDates.Concat(exerciseDates).Distinct().Count();

        var goalMl = await db.TrackerProfiles.AsNoTracking()
            .Where(p => p.UserEmail == email).Select(p => p.HydrationGoalMl)
            .FirstOrDefaultAsync(ct) ?? DefaultHydrationGoalMl;
        var hydrationByDate = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate >= from && h.LocalDate <= to)
            .GroupBy(h => h.LocalDate)
            .Select(grp => new { Date = grp.Key, Ml = grp.Sum(h => h.AmountMl) })
            .ToListAsync(ct);
        var qualifying = hydrationByDate.Where(d => d.Ml >= goalMl).Select(d => d.Date).ToHashSet();
        var hydrationDays = qualifying.Count;
        var hydrationBestStreak = LongestRun(qualifying);

        // Weight delta: first vs last reading in the window (metric-only; client converts to lb for display).
        var weights = await db.WeightEntries.AsNoTracking()
            .Where(w => w.UserEmail == email && w.LocalDate >= from && w.LocalDate <= to)
            .OrderBy(w => w.LocalDate).ThenBy(w => w.Id)
            .Select(w => w.WeightKg).ToListAsync(ct);
        double? weightDeltaKg = weights.Count >= 2 ? Math.Round(weights[^1] - weights[0], 1) : null;

        var sleepHours = await db.SleepEntries.AsNoTracking()
            .Where(s => s.UserEmail == email && s.LocalDate >= from && s.LocalDate <= to)
            .Select(s => s.Hours).ToListAsync(ct);
        double? sleepAvgHours = sleepHours.Count > 0
            ? Math.Round((double)sleepHours.Average(), 1)
            : null;

        return (daysTracked, hydrationDays, hydrationBestStreak, weightDeltaKg, sleepAvgHours);
    }

    /// <summary>The length of the LONGEST consecutive run of qualifying dates in the set. PURE set walk (0 when empty).</summary>
    internal static int LongestRun(HashSet<DateOnly> qualifying)
    {
        if (qualifying.Count == 0) return 0;
        var best = 0;
        foreach (var d in qualifying)
        {
            // Only start counting from the beginning of a run (no predecessor in the set).
            if (qualifying.Contains(d.AddDays(-1))) continue;
            var len = 0;
            var cursor = d;
            while (qualifying.Contains(cursor))
            {
                len++;
                cursor = cursor.AddDays(1);
            }
            if (len > best) best = len;
        }
        return best;
    }

    /// <summary>
    /// Build the story-card set from the already-derived numbers. PURE — no DB, no secrets, no email. A card is
    /// DROPPED when its headline number is 0 (mirrors the recap's conditional fields) so Wrapped only tells the
    /// parts of the story that actually happened. Each headline is the big number; label + sub carry the flavor.
    /// </summary>
    internal static IReadOnlyList<WrappedCard> BuildCards(
        WeeklyRecapComposer.RecapStats s, int daysTracked, int hydrationDays, int hydrationBestStreak,
        double? weightDeltaKg, double? sleepAvgHours, HardSlice? hard, int trophiesEarned, int trophiesTotal,
        TokenTotals usage)
    {
        var cards = new List<WrappedCard>();

        if (daysTracked > 0)
            cards.Add(new("days-tracked", $"{daysTracked:N0}", "Days you showed up",
                "You logged something on these days.", "primary"));

        if (s.Workouts > 0)
            cards.Add(new("workouts", $"{s.Workouts:N0}", "Workouts crushed",
                s.WorkoutMinutes > 0 ? $"{s.WorkoutMinutes:N0} minutes of work." : null, "exercise"));

        if (s.ProteinAvgG > 0)
            cards.Add(new("protein", $"{s.ProteinAvgG:N0} g", "Protein, per day",
                "Your muscles say thanks.", "food"));

        if (s.CaloriesOutTotal > 0)
            cards.Add(new("calories-out", $"{s.CaloriesOutTotal:N0}", "Calories torched",
                "Movement + watch active calories.", "exercise"));

        if (s.StepsTotal > 0)
            cards.Add(new("steps", $"{s.StepsTotal:N0}", "Steps",
                "One foot in front of the other.", "activity"));

        if (hydrationDays > 0)
            cards.Add(new("hydration", $"{hydrationDays:N0}", "Hydration wins",
                hydrationBestStreak > 0 ? $"Best run: {hydrationBestStreak} days straight." : "Days you hit your goal.", "hydration"));

        if (s.CoffeeCups > 0)
            cards.Add(new("coffee", $"{s.CoffeeCups:N0}", "Cups of coffee",
                "Fuel for the grind.", "coffee"));

        if (weightDeltaKg is { } dkg && dkg != 0)
        {
            // Surface delta in lb (the tracker's display unit); negative = lost weight.
            var dlb = Math.Round(dkg * 2.2046226218, 1);
            var sign = dlb > 0 ? "+" : "";
            cards.Add(new("weight-delta", $"{sign}{dlb:N1} lb", "Weight change",
                dlb < 0 ? "Trending down." : "First to last reading.", "weight"));
        }

        if (sleepAvgHours is { } sleep && sleep > 0)
            cards.Add(new("sleep", $"{sleep:N1} h", "Sleep, per night",
                "Average across logged nights.", "sleep"));

        if (hard is { } h && (h.TotalPoints > 0 || h.CurrentStreak > 0 || h.CompletedDays > 0))
            cards.Add(new("hard", $"{h.TotalPoints:0.#}", "75 Hard points",
                $"{h.CurrentStreak}-day streak · {h.CompletedDays} days complete this period.", "hard"));

        if (trophiesEarned > 0)
            cards.Add(new("trophies", $"{trophiesEarned:N0}", "Trophies earned",
                $"of {trophiesTotal} milestones across the Hub.", "trophy"));

        if (s.BillsSettled > 0)
            cards.Add(new("bills", $"{s.BillsSettled:N0}", "Bills settled",
                "Squared up in the Bill Splitter.", "bills"));

        if (usage.Records > 0)
            cards.Add(new("usage", $"${usage.CostUsd:N2}", "Claude Code, by the numbers",
                $"{usage.TotalTokens:N0} tokens over {usage.Records:N0} requests.", "usage"));

        return cards;
    }
}
