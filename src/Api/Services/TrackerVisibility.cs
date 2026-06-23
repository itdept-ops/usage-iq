using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The tracker's shared visibility + date + unique-violation helpers, extracted so the 75 Hard feature
/// (<c>HardChallengeEndpoints</c>) reuses the EXACT same gate as the food/fitness tracker
/// (<c>TrackerEndpoints</c>) rather than duplicating it. There is ONE source of truth for "who may read whom"
/// and for the app's display-timezone "today".
/// </summary>
public static class TrackerVisibility
{
    /// <summary>
    /// Whether <paramref name="caller"/> may READ <paramref name="target"/>'s tracker (target != self):
    /// true when the caller holds <see cref="Permissions.TrackerViewAll"/> (and the target is a real user), OR
    /// the target has <c>ShareWithContacts=true</c> and the caller is in the target's mutual chat circle.
    /// </summary>
    public static async Task<bool> CanViewAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, string target, CancellationToken ct)
    {
        if (caller.Permissions.Contains(Permissions.TrackerViewAll))
            return await db.Users.AnyAsync(u => u.Email == target, ct);

        var shares = await db.TrackerProfiles.AsNoTracking()
            .Where(p => p.UserEmail == target)
            .Select(p => (bool?)p.ShareWithContacts)
            .FirstOrDefaultAsync(ct);
        if (shares != true) return false;

        // The caller may read the target when the target has the caller in their circle (mutual edges,
        // so target→caller existing is sufficient + correct).
        return await ContactGraph.IsContactAsync(db, target, caller.Email, ct);
    }

    /// <summary>The app's display timezone, mirroring UsageQueries (UTC fallback on a bad/blank id).</summary>
    public static async Task<TimeZoneInfo> DisplayTzAsync(UsageDbContext db, CancellationToken ct)
    {
        var id = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); } catch { return TimeZoneInfo.Utc; }
    }

    /// <summary>Today in the app's display timezone (the SAME "today" the tracker uses).</summary>
    public static async Task<DateOnly> DisplayTzTodayAsync(UsageDbContext db, CancellationToken ct) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, await DisplayTzAsync(db, ct)));

    /// <summary>True when a save failed on a Postgres UNIQUE violation (the upsert race signal).</summary>
    public static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
