using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The tracker's shared REQUEST-SCOPED helpers, extracted so the food/fitness tracker
/// (<c>TrackerEndpoints</c>), the 75 Hard feature (<c>HardChallengeEndpoints</c>), and the AI endpoints
/// (<c>AiEndpoints</c>) all resolve the SAME target user, the SAME "date-or-today", and the SAME date-active
/// goal targets — rather than keeping parallel copies that can silently drift on health/fitness data.
///
/// <para>Each method is a behavior-preserving move of logic that previously existed identically in more than one
/// endpoint file: the EF queries, the ordinal/case-insensitive email comparisons, the 400/404 outcomes, and the
/// display-timezone "today" fallback are unchanged. It leans on the existing static <see cref="TrackerVisibility"/>
/// helpers (display-tz "today", the visibility gate, the unique-violation signal) rather than re-implementing them.</para>
///
/// <para>Registered <c>Scoped</c> in DI (like the other per-request services). Handlers take it as an injected
/// parameter; the deeper private static helpers that only carry a <see cref="UsageDbContext"/> call the matching
/// <c>static ... Core</c> entry point so the implementation still lives in exactly ONE place.</para>
/// </summary>
public sealed class TrackerService
{
    private readonly UsageDbContext _db;

    public TrackerService(UsageDbContext db) => _db = db;

    // ===================================================================================
    // Target-user resolution (whose data am I acting on — self vs another user)
    // ===================================================================================

    /// <summary>
    /// The resolved outcome of a <c>?user={userId}</c> lookup: the target's (lower-cased) email, whether it is the
    /// caller themselves, and an optional short-circuit <see cref="IResult"/> (400 for a non-positive id, 404 for an
    /// id that resolves to nobody). Exactly one of {<see cref="Error"/> is set} / {<see cref="Target"/> is usable}
    /// holds — when <see cref="Error"/> is non-null the caller returns it immediately and ignores the rest.
    /// </summary>
    public readonly record struct TargetResolution(string Target, bool IsSelf, IResult? Error);

    /// <summary>
    /// Resolve the tracker target from an optional <c>?user={userId}</c>: no id ⇒ self; a non-positive id ⇒ 400; an
    /// id that resolves to no user ⇒ 404 (never leak that the user / their tracker exists); otherwise the target's
    /// stored (lower-cased) email + whether it equals the caller (case-insensitive). The client never holds another
    /// user's email (email-privacy), so it sends the id and the server resolves it here.
    /// </summary>
    public Task<TargetResolution> ResolveTargetAsync(
        int? user, CurrentUserAccessor.CurrentUser caller, CancellationToken ct) =>
        ResolveTargetCoreAsync(_db, user, caller, ct);

    /// <summary>The <see cref="ResolveTargetAsync"/> implementation as a static core so the endpoint files' private
    /// static helpers share the exact same logic (no second copy).</summary>
    public static async Task<TargetResolution> ResolveTargetCoreAsync(
        UsageDbContext db, int? user, CurrentUserAccessor.CurrentUser caller, CancellationToken ct)
    {
        if (user is not int targetId)
            return new TargetResolution(caller.Email, true, null);
        if (targetId <= 0)
            return new TargetResolution("", false,
                Results.BadRequest(new { message = "`user` must be a positive user id." }));

        var targetEmail = await db.Users.AsNoTracking()
            .Where(u => u.Id == targetId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(targetEmail))
            return new TargetResolution("", false, Results.NotFound());

        var isSelf = string.Equals(targetEmail, caller.Email, StringComparison.OrdinalIgnoreCase);
        return new TargetResolution(targetEmail, isSelf, null);
    }

    // ===================================================================================
    // Date resolution ("yyyy-MM-dd", else today in the display timezone)
    // ===================================================================================

    /// <summary>Parse the client's <c>yyyy-MM-dd</c> date, or fall back to "today" in the app's display timezone.</summary>
    public Task<DateOnly> ResolveDateAsync(string? date, CancellationToken ct) =>
        ResolveDateCoreAsync(_db, date, ct);

    /// <summary>The <see cref="ResolveDateAsync"/> implementation as a static core (single source of truth).</summary>
    public static async Task<DateOnly> ResolveDateCoreAsync(UsageDbContext db, string? date, CancellationToken ct)
    {
        if (TryParseDate(date, out var parsed)) return parsed;
        return await TrackerVisibility.DisplayTzTodayAsync(db, ct);
    }

    /// <summary>Parse a strict <c>yyyy-MM-dd</c> date; false on null/blank/malformed input.</summary>
    public static bool TryParseDate(string? date, out DateOnly result) =>
        DateOnly.TryParseExact((date ?? "").Trim(), "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out result);

    // ===================================================================================
    // Goal-plan resolution (history-correct day/stats targets)
    // ===================================================================================

    /// <summary>The GoalPlan active on <paramref name="date"/> = the row with the greatest <c>EffectiveFrom &lt;= date</c>
    /// for the user; null when the user has no plan on/before that date (the caller then falls back to the live
    /// profile targets).</summary>
    public static Task<GoalPlan?> ActivePlanForDateAsync(
        UsageDbContext db, string email, DateOnly date, CancellationToken ct) =>
        db.GoalPlans.AsNoTracking()
            .Where(p => p.UserEmail == email && p.EffectiveFrom <= date)
            .OrderByDescending(p => p.EffectiveFrom)
            .FirstOrDefaultAsync(ct);

    /// <summary>
    /// Resolve the calorie/macro targets to score a date against: the active plan's snapshot, else the live profile
    /// fallback. After the backfill every existing user has a 0001-01-01 plan, so the plan branch covers all
    /// historical dates; the profile fallback is the safety net for the transient gap before the first goal is saved.
    /// The SAME resolution the day view, the AI recap, and the recovery snapshot all use.
    /// </summary>
    public Task<TrackerStats.GoalTargets> ResolveTargetsAsync(
        string email, DateOnly date, TrackerProfile? profile, CancellationToken ct) =>
        ResolveTargetsCoreAsync(_db, email, date, profile, ct);

    /// <summary>The <see cref="ResolveTargetsAsync"/> implementation as a static core (single source of truth).</summary>
    public static async Task<TrackerStats.GoalTargets> ResolveTargetsCoreAsync(
        UsageDbContext db, string email, DateOnly date, TrackerProfile? profile, CancellationToken ct)
    {
        var plan = await ActivePlanForDateAsync(db, email, date, ct);
        return plan is null
            ? TrackerStats.TargetsFromProfile(profile)
            : TrackerStats.TargetsFromPlan(plan);
    }
}
