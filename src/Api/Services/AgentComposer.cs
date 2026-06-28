using System.Text;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Services;

/// <summary>
/// Per-kind composition for the proactive scheduled agents. Each kind has a GUARANTEED deterministic floor
/// (computed entirely from the user's own server-side data); an AI narrative is an OPTIONAL upgrade that only
/// runs when the user holds the relevant EXISTING AI key (family.ai for the briefing, finance.ai for the
/// budget alert) and silently degrades to the floor on any error / when Gemini is unconfigured. This same
/// service backs both the background <see cref="AgentScheduler"/> tick and the preview/test endpoints, so a
/// preview shows exactly what would be delivered.
///
/// <para>Self-scoped: a composer only ever reads the agent's OWN owner's data (keyed by the lower-cased
/// <see cref="ScheduledAgent.UserEmail"/>). The LowStaples nudge additionally honours the household's union of
/// standing dietary allergies/avoids — it never names a staple that matches an excluded term.</para>
/// </summary>
public sealed class AgentComposer(
    UsageDbContext db, FamilyBriefingService briefing, GeminiService gemini, IMemoryCache cache)
{
    /// <summary>A composed nudge: the bell/push text + the in-app deep link it opens. <see cref="FellBackToPlain"/>
    /// is true when the AI narrative was NOT used (unconfigured / errored / the user lacks the AI key) — handy
    /// for the preview endpoint.</summary>
    public sealed record Nudge(string Text, string Link, bool FellBackToPlain);

    private static readonly TimeSpan NarrativeCacheTtl = TimeSpan.FromHours(12);

    /// <summary>
    /// Compose the nudge for <paramref name="agent"/> as of <paramref name="nowUtc"/> (in the agent's own
    /// timezone), or null when there is genuinely nothing to say (e.g. no incomplete streak tasks, staples
    /// fully stocked). Honours the AI-floor + existing-AI-key gate per kind. Never throws on the AI side.
    /// </summary>
    public async Task<Nudge?> ComposeAsync(
        UsageDbContext _, ScheduledAgent agent, DateTime nowUtc, CancellationToken ct = default)
    {
        var email = agent.UserEmail.Trim().ToLowerInvariant();
        var tz = AgentScheduler.ResolveTimeZone(agent.TimeZone);
        var localDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc), tz));

        return agent.Kind switch
        {
            ScheduledAgentKind.MorningBriefing => await MorningBriefingAsync(email, nowUtc, ct),
            ScheduledAgentKind.StreakRescue => await StreakRescueAsync(email, localDate, ct),
            ScheduledAgentKind.BudgetAlert => await BudgetAlertAsync(email, localDate, ct),
            ScheduledAgentKind.LowStaples => await LowStaplesAsync(email, ct),
            _ => null,
        };
    }

    // ---- MorningBriefing: a per-USER wrapper of the household morning briefing ----

    /// <summary>
    /// Reuse <see cref="FamilyBriefingService"/> verbatim: build the user's household briefing text (AI
    /// narrative gated on family.ai held by SOMEONE in the household, deterministic Compose() floor otherwise)
    /// and deliver it to THIS user only. Returns null if the user isn't in a household (nothing to brief).
    /// </summary>
    private async Task<Nudge?> MorningBriefingAsync(string email, DateTime nowUtc, CancellationToken ct)
    {
        var caller = await ResolveCallerAsync(email, ct);
        if (caller is null) return null;

        var householdId = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.UserId == caller.Id)
            .Select(m => (int?)m.HouseholdId)
            .FirstOrDefaultAsync(ct);
        if (householdId is null) return null;

        var household = await db.Households.AsNoTracking()
            .FirstOrDefaultAsync(h => h.Id == householdId.Value, ct);
        if (household is null) return null;

        // family.ai is the gate (held by THIS user) — the briefing text helper spends tokens only when allowed,
        // and always returns the deterministic Compose() floor otherwise / on any AI error.
        var allowAi = caller.Permissions.Contains(Permissions.FamilyAi);
        var result = await briefing.BriefingTextForAsync(household, caller, nowUtc, allowAi, ct);
        var text = result.Narrative;
        return new Nudge(Clamp(text), "/family/today", result.FellBackToPlain);
    }

    // ---- StreakRescue: late-day nudge when today's 75-Hard / hydration tasks are incomplete ----

    /// <summary>
    /// Look at the user's ACTIVE 75-Hard run for <paramref name="localDate"/>: which enabled tasks are NOT yet
    /// complete (diet/water/workout auto-scored live; manual tasks from the day row), plus the current streak.
    /// Returns null when there's no active run or everything's already done (nothing to rescue). The AI
    /// narrative upgrade is gated on the user holding <c>tracker.ai</c> (the tracker's existing AI key); the
    /// deterministic line is always the floor.
    /// </summary>
    private async Task<Nudge?> StreakRescueAsync(string email, DateOnly localDate, CancellationToken ct)
    {
        var challenge = await db.HardChallenges.AsNoTracking()
            .FirstOrDefaultAsync(c => c.UserEmail == email && c.Status == HardChallengeStatus.Active, ct);
        if (challenge is null) return null;

        var tasks = await db.HardChallengeTasks.AsNoTracking()
            .Where(t => t.ChallengeId == challenge.Id && t.Enabled)
            .OrderBy(t => t.SortOrder)
            .ToListAsync(ct);
        if (tasks.Count == 0) return null;

        // Manual progress rows for today (auto tasks recompute live; we approximate "done" deterministically:
        // diet uses the day override, water sums today's hydration, manual tasks use their stored value/done).
        var dayTasks = await db.HardChallengeDayTasks.AsNoTracking()
            .Where(t => t.UserEmail == email && t.LocalDate == localDate)
            .ToDictionaryAsync(t => t.TaskId, ct);
        var hydrationMl = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate == localDate)
            .SumAsync(h => (int?)h.AmountMl, ct) ?? 0;
        var day = await db.HardChallengeDays.AsNoTracking()
            .FirstOrDefaultAsync(d => d.UserEmail == email && d.LocalDate == localDate, ct);

        var incomplete = new List<string>();
        foreach (var t in tasks)
        {
            var done = t.AutoSource switch
            {
                HardTaskAutoSource.Water => t.TargetValue is { } target && hydrationMl >= (decimal)target,
                HardTaskAutoSource.Diet => day?.DietOverride == true,
                HardTaskAutoSource.NoAlcohol => day?.NoAlcohol ?? false,
                // Workout auto-scoring needs the full live computation; treat as "not yet confirmed done" so the
                // nudge errs toward reminding (never claims a workout is done when we can't cheaply verify it).
                HardTaskAutoSource.Workout => false,
                _ => dayTasks.TryGetValue(t.Id, out var dt)
                    && (dt.Done == true || (t.TargetValue is { } tv && dt.Value is { } v && v >= tv)),
            };
            if (!done) incomplete.Add(t.Label);
        }
        if (incomplete.Count == 0) return null; // everything done — nothing to rescue

        var plain = StreakFloor(incomplete, challenge.CurrentStreak);

        // AI upgrade gated on tracker.ai.
        var caller = await ResolveCallerAsync(email, ct);
        var allowAi = caller is not null && caller.Permissions.Contains(Permissions.TrackerAi);
        if (!allowAi) return new Nudge(plain, "/challenge", true);

        var facts = StreakFacts(incomplete, challenge.CurrentStreak);
        var text = await CachedNarrativeAsync(
            $"agent:streak:{email}:{localDate:yyyy-MM-dd}", plain,
            () => gemini.StreakRescueNarrativeAsync(facts, ct));
        return new Nudge(Clamp(text.Text), "/challenge", text.FellBack);
    }

    private static string StreakFloor(IReadOnlyList<string> incomplete, int streak)
    {
        var n = incomplete.Count;
        var streakBit = streak > 0 ? $" Keep your {streak}-day streak alive — " : " ";
        var list = n <= 3 ? string.Join(", ", incomplete) : $"{incomplete.Count} tasks";
        return Clamp($"You still have {n} {Plural(n, "task", "tasks")} left today.{streakBit}finish: {list}.");
    }

    private static string StreakFacts(IReadOnlyList<string> incomplete, int streak)
    {
        var sb = new StringBuilder();
        sb.Append("CURRENT_STREAK_DAYS: ").Append(streak).Append('\n');
        sb.Append("INCOMPLETE_TASKS (").Append(incomplete.Count).Append("):\n");
        foreach (var t in incomplete.Take(10)) sb.Append("- ").Append(t).Append('\n');
        return sb.ToString();
    }

    // ---- BudgetAlert: month-to-date household spend pace ----

    /// <summary>
    /// Compute the user's household month-to-date EXPENSE spend (transfers excluded) and a simple pace
    /// projection, plus the top spend categories. Returns null when the user isn't in a household or there's
    /// no spend yet this month. The AI narrative upgrade is gated on <c>finance.ai</c>; the deterministic line
    /// is always the floor.
    /// </summary>
    private async Task<Nudge?> BudgetAlertAsync(string email, DateOnly localDate, CancellationToken ct)
    {
        var caller = await ResolveCallerAsync(email, ct);
        if (caller is null) return null;

        var householdId = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.UserId == caller.Id)
            .Select(m => (int?)m.HouseholdId)
            .FirstOrDefaultAsync(ct);
        if (householdId is null) return null;

        var monthStart = new DateOnly(localDate.Year, localDate.Month, 1);
        var rows = await db.FinanceTransactions.AsNoTracking()
            .Where(t => t.HouseholdId == householdId.Value && t.Kind == "expense"
                && t.Date >= monthStart && t.Date <= localDate)
            .Select(t => new { t.Magnitude, t.Category })
            .ToListAsync(ct);
        if (rows.Count == 0) return null;

        var spent = rows.Sum(r => r.Magnitude);
        if (spent <= 0) return null;

        var dayOfMonth = localDate.Day;
        var daysInMonth = DateTime.DaysInMonth(localDate.Year, localDate.Month);
        var projected = dayOfMonth > 0 ? Math.Round(spent / dayOfMonth * daysInMonth, 0) : spent;

        var topCategories = rows
            .Where(r => !string.IsNullOrWhiteSpace(r.Category))
            .GroupBy(r => r.Category!)
            .Select(g => new { Category = g.Key, Total = g.Sum(x => x.Magnitude) })
            .OrderByDescending(g => g.Total)
            .Take(3)
            .ToList();

        var plain = Clamp(
            $"This month so far you've spent ${Math.Round(spent, 0):N0} over {dayOfMonth} " +
            $"{Plural(dayOfMonth, "day", "days")}" +
            (topCategories.Count > 0 ? $" (top: {topCategories[0].Category})" : "") +
            $" — on pace for about ${projected:N0} by month-end.");

        var allowAi = caller.Permissions.Contains(Permissions.FinanceAi);
        if (!allowAi) return new Nudge(plain, "/family/finance", true);

        var facts = BudgetFacts(spent, projected, dayOfMonth, daysInMonth,
            topCategories.Select(c => (c.Category, c.Total)).ToList());
        var text = await CachedNarrativeAsync(
            $"agent:budget:{email}:{localDate:yyyy-MM-dd}", plain,
            () => gemini.BudgetAlertNarrativeAsync(facts, ct));
        return new Nudge(Clamp(text.Text), "/family/finance", text.FellBack);
    }

    private static string BudgetFacts(
        decimal spent, decimal projected, int dayOfMonth, int daysInMonth,
        IReadOnlyList<(string Category, decimal Total)> top)
    {
        var sb = new StringBuilder();
        sb.Append("MONTH_TO_DATE_SPEND_USD: ").Append(Math.Round(spent, 2)).Append('\n');
        sb.Append("DAY_OF_MONTH: ").Append(dayOfMonth).Append(" of ").Append(daysInMonth).Append('\n');
        sb.Append("PROJECTED_MONTH_END_USD: ").Append(projected).Append('\n');
        if (top.Count > 0)
        {
            sb.Append("TOP_CATEGORIES:\n");
            foreach (var (cat, total) in top)
                sb.Append("- ").Append(cat).Append(": $").Append(Math.Round(total, 2)).Append('\n');
        }
        return sb.ToString();
    }

    // ---- LowStaples: shopping-list staples running low ----

    /// <summary>
    /// Scan the user's household SHOPPING lists for OPEN (not-checked-off) items — the staples that need
    /// buying. Returns null when nothing's open. NO AI (and no token spend): the floor lists the items by name.
    /// DIETARY EXCLUSION — any item whose text matches a term in the household's union of standing
    /// allergies/avoids is dropped from the nudge (never surfaced as "grab this").
    /// </summary>
    private async Task<Nudge?> LowStaplesAsync(string email, CancellationToken ct)
    {
        var caller = await ResolveCallerAsync(email, ct);
        if (caller is null) return null;

        var householdId = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.UserId == caller.Id)
            .Select(m => (int?)m.HouseholdId)
            .FirstOrDefaultAsync(ct);
        if (householdId is null) return null;

        // Open items across the household's ACTIVE shopping lists.
        var openItems = await db.FamilyListItems.AsNoTracking()
            .Where(i => !i.Done
                && db.FamilyLists.Any(l => l.Id == i.ListId
                    && l.HouseholdId == householdId.Value
                    && l.Kind == "shopping"
                    && l.ArchivedUtc == null))
            .OrderBy(i => i.SortOrder)
            .Select(i => i.Text)
            .Take(50)
            .ToListAsync(ct);
        if (openItems.Count == 0) return null;

        // DIETARY EXCLUSION: load the household's union of standing allergies/avoids and drop any matching item.
        var excluded = await HouseholdExcludedTermsAsync(householdId.Value, ct);
        var items = openItems
            .Where(text => !string.IsNullOrWhiteSpace(text) && !MatchesExcluded(text, excluded))
            .ToList();
        if (items.Count == 0) return null; // everything open was an excluded term — say nothing

        var shown = items.Take(5).ToList();
        var more = items.Count - shown.Count;
        var list = string.Join(", ", shown) + (more > 0 ? $", and {more} more" : "");
        var plain = Clamp(
            $"Your shopping list has {items.Count} {Plural(items.Count, "item", "items")} to grab: {list}.");
        return new Nudge(plain, "/grocery", true); // deterministic only — no AI, no token spend
    }

    /// <summary>The household's union of standing dietary allergies/avoids (lower-cased terms), read from every
    /// member's <see cref="TrackerProfile.Restrictions"/> (a comma list). Empty when none are set.</summary>
    private async Task<IReadOnlyList<string>> HouseholdExcludedTermsAsync(int householdId, CancellationToken ct)
    {
        var memberEmails = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId)
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => u.Email)
            .ToListAsync(ct);
        if (memberEmails.Count == 0) return Array.Empty<string>();

        var parts = await db.TrackerProfiles.AsNoTracking()
            .Where(p => memberEmails.Contains(p.UserEmail) && p.Restrictions != null && p.Restrictions != "")
            .Select(p => p.Restrictions!)
            .ToListAsync(ct);

        return parts
            .SelectMany(p => p.Split(','))
            .Select(t => t.Trim().ToLowerInvariant())
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Whether <paramref name="text"/> mentions any excluded term (case-insensitive substring).</summary>
    private static bool MatchesExcluded(string text, IReadOnlyList<string> excluded)
    {
        if (excluded.Count == 0) return false;
        var lower = text.ToLowerInvariant();
        return excluded.Any(term => lower.Contains(term, StringComparison.Ordinal));
    }

    // ---- Shared helpers ----

    /// <summary>
    /// Resolve an AI narrative via <paramref name="narrate"/>, caching the result per <paramref name="cacheKey"/>
    /// so the preview/test and the scheduled run don't re-spend tokens within a local day. Falls back to
    /// <paramref name="plain"/> (the deterministic floor) on null/blank/error. NEVER throws.
    /// </summary>
    private async Task<(string Text, bool FellBack)> CachedNarrativeAsync(
        string cacheKey, string plain, Func<Task<string?>> narrate)
    {
        if (!gemini.IsConfigured) return (plain, true);
        if (cache.TryGetValue(cacheKey, out string? cached) && !string.IsNullOrWhiteSpace(cached))
            return (cached!, false);
        try
        {
            var narrative = await narrate();
            if (string.IsNullOrWhiteSpace(narrative)) return (plain, true);
            var capped = Clamp(narrative);
            cache.Set(cacheKey, capped, NarrativeCacheTtl);
            return (capped, false);
        }
        catch
        {
            return (plain, true); // AI must never fail the nudge — the floor stands
        }
    }

    private async Task<CurrentUserAccessor.CurrentUser?> ResolveCallerAsync(string email, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking()
            .Include(x => x.Permissions)
            .Where(x => x.Email == email && x.IsEnabled)
            .FirstOrDefaultAsync(ct);
        if (u is null) return null;
        return new CurrentUserAccessor.CurrentUser(
            u.Id, u.Email, u.Name, u.IsEnabled,
            u.Permissions.Select(p => p.Permission).ToHashSet(StringComparer.Ordinal),
            u.HomeRoute, u.Picture, u.DisplayNameMode, u.Nickname);
    }

    private static string Plural(int n, string one, string many) => n == 1 ? one : many;

    /// <summary>Cap a nudge body at the Notification.Text length (512).</summary>
    private static string Clamp(string s) => s.Length > 512 ? s[..512] : s;
}
