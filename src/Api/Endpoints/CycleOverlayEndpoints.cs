using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub — Cycle PREDICTED-phase overlay for the household calendar (GET /api/family/cycle/overlay).
///
/// <para>Gated by <see cref="Permissions.FamilyUse"/> (NOT <c>cycle.track</c>): household members see the
/// opted-in members' overlay, exactly like the calendar event overlay. For the CALLER themselves (only if they
/// hold <c>cycle.track</c>) AND each OTHER household member whose <c>CycleProfile.OverlayToFamily</c> is true,
/// it returns ONLY PREDICTED period/fertile day-spans over the requested window.</para>
///
/// <para>PRIVACY: identity is userId + display NAME only — NEVER an email. ONLY predicted spans are returned
/// (raw logged periods are NEVER exposed). A member who hasn't opted in never appears. The window is clamped to
/// ≤92 days. The spans are deterministic projections from <see cref="CyclePredictionService"/> — informational,
/// non-medical, labelled "predicted".</para>
/// </summary>
public static class CycleOverlayEndpoints
{
    /// <summary>One PREDICTED phase span (NEVER a raw logged entry). <see cref="Predicted"/> is always true —
    /// the field exists so the UI labels it "Period (predicted)"/"Fertile window (predicted)".</summary>
    public sealed record PhaseSpanDto(string Kind, DateOnly Start, DateOnly End, bool Predicted);

    /// <summary>One member's predicted spans for the overlay (identity by userId + display NAME only).</summary>
    public sealed record MemberOverlayDto(int UserId, string Name, IReadOnlyList<PhaseSpanDto> Phases);

    private const int MaxWindowDays = 92;

    public static void MapCycleOverlayEndpoints(this WebApplication app)
    {
        app.MapGet("/api/family/cycle/overlay", async (
            DateTime? fromUtc, DateTime? toUtc, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // family.use filter guarantees non-null
            var household = await households.GetForCallerAsync(caller, ct);
            var (from, to) = await Window(db, fromUtc, toUtc, ct);

            // Build the set of users to surface: the caller themselves ONLY if they cycle.track, plus each
            // OTHER household member whose CycleProfile.OverlayToFamily is true. A member who hasn't opted in
            // (or has no profile row) never appears. Identity is userId + name (NEVER email).
            var memberIds = household is null
                ? new List<int>()
                : await db.HouseholdMembers.AsNoTracking()
                    .Where(m => m.HouseholdId == household.Id)
                    .Select(m => m.UserId)
                    .ToListAsync(ct);

            // Other members who opted in (overlay flag true). The caller is handled separately so their own
            // overlay flag is irrelevant — they always see their OWN predictions (when they cycle.track).
            var optedInOthers = await db.CycleProfiles.AsNoTracking()
                .Where(p => p.OverlayToFamily && p.UserId != caller.Id && memberIds.Contains(p.UserId))
                .Select(p => p.UserId)
                .ToListAsync(ct);

            var subjectIds = new HashSet<int>(optedInOthers);
            if (caller.Permissions.Contains(Permissions.CycleTrack))
                subjectIds.Add(caller.Id);

            if (subjectIds.Count == 0) return Results.Ok(Array.Empty<MemberOverlayDto>());

            // Resolve identity (userId + display name; NEVER email) and the profiles (for the per-user averages
            // the projection needs). One pass each, scoped to the subjects.
            var users = await db.Users.AsNoTracking()
                .Where(u => subjectIds.Contains(u.Id))
                .Select(u => new { u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname })
                .ToListAsync(ct);
            var profiles = (await db.CycleProfiles.AsNoTracking()
                    .Where(p => subjectIds.Contains(p.UserId))
                    .ToListAsync(ct))
                .ToDictionary(p => p.UserId);

            // Logged periods for every subject in one query (keyed by email), grouped in memory. These never
            // leave the server as raw rows — they only feed the deterministic projection.
            var emails = users.Select(u => u.Email).ToList();
            var periodsByEmail = (await db.CyclePeriods.AsNoTracking()
                    .Where(p => emails.Contains(p.UserEmail))
                    .ToListAsync(ct))
                .GroupBy(p => p.UserEmail, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(grp => grp.Key, grp => grp.ToList(), StringComparer.OrdinalIgnoreCase);

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var result = new List<MemberOverlayDto>();
            foreach (var u in users)
            {
                var avgCycle = profiles.TryGetValue(u.Id, out var pr) ? pr.AvgCycleLengthDays : 28;
                var avgPeriod = profiles.TryGetValue(u.Id, out var pr2) ? pr2.AvgPeriodLengthDays : 5;
                var periods = periodsByEmail.TryGetValue(u.Email, out var ps) ? ps : new();

                var prediction = CyclePredictionService.Compute(periods, avgCycle, avgPeriod, today);
                var spans = CyclePredictionService.OverlaySpans(prediction, avgPeriod, from, to);
                if (spans.Count == 0) continue; // nothing to project (no logged history) — omit the member

                result.Add(new MemberOverlayDto(
                    u.Id,
                    DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname),
                    spans.Select(s => new PhaseSpanDto(s.Kind, s.Start, s.End, true)).ToList()));
            }

            return Results.Ok(result);
        })
        .RequireAuthorization()
        .RequirePermission(Permissions.FamilyUse);
    }

    /// <summary>Resolve a [from, to] DAY window with sane defaults (display-tz today → +35 days) and a hard
    /// ≤92-day clamp so the overlay can't enumerate an unbounded range across members.</summary>
    private static async Task<(DateOnly From, DateOnly To)> Window(
        UsageDbContext db, DateTime? fromUtc, DateTime? toUtc, CancellationToken ct)
    {
        var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
        var from = fromUtc is { } f ? DateOnly.FromDateTime(f) : today;
        var to = toUtc is { } t ? DateOnly.FromDateTime(t) : from.AddDays(35);
        if (to < from) to = from.AddDays(1);
        if (to.DayNumber - from.DayNumber > MaxWindowDays) to = from.AddDays(MaxWindowDays);
        return (from, to);
    }
}
