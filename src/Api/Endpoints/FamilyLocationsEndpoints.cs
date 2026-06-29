using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family-finder locations (/api/family/locations): the latest PRECISE pin for opted-in members of the
/// CALLER's own household. Gated by <see cref="Permissions.FamilyUse"/> on top of <c>.RequireAuthorization()</c>.
///
/// This is DISTINCT from the admin map (<c>GET /api/location/admin</c>, which is <c>location.view-all</c> over
/// ALL users) and from the coarse-city presence sharing. For the family-finder, a member's
/// <see cref="Data.Entities.AppUser.LocationShareHousehold"/> opt-in IS the consent to surface their exact
/// latest location to the household — so the precise lat/lng is intentionally returned here.
///
/// PRIVACY (enforced server-side):
/// <list type="bullet">
///   <item>Only the CALLER's own household is ever resolved — there's no way to address another household.</item>
///   <item>The CALLER always sees their OWN latest pin (if they have any history), regardless of sharing.</item>
///   <item>Every OTHER member appears ONLY if they have <c>LocationShareHousehold = true</c> AND a recent fix.
///   Non-sharers and members without a recent fix are omitted entirely.</item>
///   <item>Identity is userId + display name ONLY — an email is never put on the wire.</item>
/// </list>
/// </summary>
public static class FamilyLocationsEndpoints
{
    /// <summary>How fresh a shared fix must be to surface another member on the finder. The caller's own
    /// latest pin is exempt (they always see themselves).</summary>
    private static readonly TimeSpan RecentWindow = TimeSpan.FromHours(24);

    /// <summary>Hard upper bound on the replay window. A request for more than this is CLAMPED (we keep the
    /// caller's <c>to</c> and pull back the start) so the history read can never walk unbounded backwards.</summary>
    private static readonly TimeSpan MaxHistoryWindow = TimeSpan.FromHours(48);

    /// <summary>Default window when the caller omits <c>from</c>/<c>to</c>: the most recent 24h up to now.</summary>
    private static readonly TimeSpan DefaultHistoryWindow = TimeSpan.FromHours(24);

    /// <summary>Max points returned PER MEMBER. The in-window track is evenly downsampled to at most this many
    /// (first + last always kept) so a busy tracker can't produce a huge payload.</summary>
    private const int MaxPointsPerMember = 300;

    public static void MapFamilyLocationsEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        // ---- The family-finder: opted-in household members' latest PRECISE pins ----
        g.MapGet("/locations", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // family.use filter guarantees non-null
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!; // family.use ⇒ always provisioned

            // The household members resolved to id + display identity (never email). The member rows carry
            // only userId; join to Users for name + the share opt-in flag.
            var members = await db.HouseholdMembers.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id)
                .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new
                {
                    u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname, u.LocationShareHousehold,
                })
                .ToListAsync(ct);

            if (members.Count == 0) return Results.Ok(new List<FamilyMemberLocationDto>());

            // Who is eligible for a pin: the caller themselves (always), plus any OTHER member who has
            // opted into household sharing. Non-sharers (other than the caller) never appear.
            var eligibleEmails = members
                .Where(m => m.Id == caller.Id || m.LocationShareHousehold)
                .Select(m => m.Email)
                .ToList();
            if (eligibleEmails.Count == 0) return Results.Ok(new List<FamilyMemberLocationDto>());

            var cutoff = DateTime.UtcNow - RecentWindow;

            // Pull the candidate fixes for eligible members. For non-self members we additionally require the
            // fix to be recent; the caller's own latest is never filtered by freshness. We fetch a bounded
            // recent window and reduce to the newest-per-user in memory.
            var rows = await db.UserLocations.AsNoTracking()
                .Where(x => eligibleEmails.Contains(x.UserEmail)
                    && (x.UserEmail == caller.Email || x.CapturedUtc >= cutoff))
                .OrderByDescending(x => x.CapturedUtc)
                .ToListAsync(ct);

            // userId + name lookup keyed by the owner email (email never reaches the DTO).
            var byEmail = members.ToDictionary(m => m.Email, m => m, StringComparer.OrdinalIgnoreCase);

            var result = rows
                .GroupBy(r => r.UserEmail, StringComparer.OrdinalIgnoreCase)
                .Select(grp =>
                {
                    var latest = grp.OrderByDescending(x => x.CapturedUtc).First();
                    byEmail.TryGetValue(grp.Key, out var owner);
                    return new FamilyMemberLocationDto
                    {
                        UserId = owner?.Id ?? 0,
                        Name = owner is null ? "Unknown user" : DisplayName.Format(owner.Name, owner.DisplayNameMode, owner.Nickname),
                        IsSelf = owner is not null && owner.Id == caller.Id,
                        Lat = latest.Lat,
                        Lng = latest.Lng,
                        City = latest.City,
                        Region = latest.Region,
                        Country = latest.Country,
                        AccuracyM = latest.AccuracyM,
                        CapturedUtc = latest.CapturedUtc,
                    };
                })
                // Self first, then by name — a stable, finder-friendly order.
                .OrderBy(d => d.IsSelf ? 0 : 1)
                .ThenBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return Results.Ok(result);
        });

        // ---- The replay: opted-in household members' ordered HISTORY over a bounded window ----
        // Same gate (family.use), same household scope, and the SAME opt-in rule as the live finder above:
        // the caller always sees their OWN track; every OTHER member appears ONLY when LocationShareHousehold
        // is true. The window is CLAMPED to MaxHistoryWindow server-side and each member's track is evenly
        // DOWNSAMPLED to MaxPointsPerMember — the client cannot widen the window or ask for more points.
        g.MapGet("/locations/history", async (
            DateTime? from, DateTime? to,
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // family.use filter guarantees non-null
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!; // family.use ⇒ always provisioned

            // Resolve + clamp the window entirely server-side (UTC). `to` defaults to now; `from` defaults to a
            // DefaultHistoryWindow back. Then pull `from` forward so (to - from) never exceeds MaxHistoryWindow,
            // and guard against an inverted range. The client's values are advisory; these bounds are not.
            var toUtc = NormalizeUtc(to) ?? DateTime.UtcNow;
            var fromUtc = NormalizeUtc(from) ?? toUtc - DefaultHistoryWindow;
            if (fromUtc > toUtc) fromUtc = toUtc;
            if (toUtc - fromUtc > MaxHistoryWindow) fromUtc = toUtc - MaxHistoryWindow;

            // Same household → id + display identity (never email) + the share opt-in flag, exactly as the finder.
            var members = await db.HouseholdMembers.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id)
                .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new
                {
                    u.Id, u.Email, u.Name, u.DisplayNameMode, u.Nickname, u.LocationShareHousehold,
                })
                .ToListAsync(ct);

            if (members.Count == 0) return Results.Ok(new List<FamilyMemberHistoryDto>());

            // Eligibility is IDENTICAL to the live finder: the caller always (even if not sharing), plus any
            // OTHER member who opted into household sharing. A member who never opted in NEVER appears in history.
            var eligible = members
                .Where(m => m.Id == caller.Id || m.LocationShareHousehold)
                .ToList();
            if (eligible.Count == 0) return Results.Ok(new List<FamilyMemberHistoryDto>());

            var eligibleEmails = eligible.Select(m => m.Email).ToList();

            // Pull every in-window fix for the eligible members (bounded by the clamped window above). Email is
            // the storage key and never reaches the DTO. Ordered oldest→newest for the replay timeline.
            var rows = await db.UserLocations.AsNoTracking()
                .Where(x => eligibleEmails.Contains(x.UserEmail)
                    && x.CapturedUtc >= fromUtc && x.CapturedUtc <= toUtc)
                .OrderBy(x => x.CapturedUtc)
                .ToListAsync(ct);

            var byEmail = members.ToDictionary(m => m.Email, m => m, StringComparer.OrdinalIgnoreCase);

            var result = rows
                .GroupBy(r => r.UserEmail, StringComparer.OrdinalIgnoreCase)
                .Select(grp =>
                {
                    byEmail.TryGetValue(grp.Key, out var owner);
                    var ordered = grp.OrderBy(x => x.CapturedUtc).ToList();
                    var points = Downsample(ordered, MaxPointsPerMember)
                        .Select(x => new LocationHistoryPointDto
                        {
                            Lat = x.Lat,
                            Lng = x.Lng,
                            AccuracyM = x.AccuracyM,
                            CapturedUtc = x.CapturedUtc,
                        })
                        .ToList();
                    return new FamilyMemberHistoryDto
                    {
                        UserId = owner?.Id ?? 0,
                        Name = owner is null ? "Unknown user" : DisplayName.Format(owner.Name, owner.DisplayNameMode, owner.Nickname),
                        IsSelf = owner is not null && owner.Id == caller.Id,
                        Points = points,
                    };
                })
                .Where(d => d.Points.Count > 0)
                // Self first, then by name — the same stable order as the finder.
                .OrderBy(d => d.IsSelf ? 0 : 1)
                .ThenBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return Results.Ok(result);
        });
    }

    /// <summary>Treat an incoming timestamp as UTC (so a client sending an unspecified-kind ISO string is not
    /// silently shifted by the server's local offset). Null stays null.</summary>
    private static DateTime? NormalizeUtc(DateTime? value) => value is null
        ? null
        : DateTime.SpecifyKind(value.Value.ToUniversalTime(), DateTimeKind.Utc);

    /// <summary>Evenly downsample an oldest→newest list to at most <paramref name="max"/> points, always keeping
    /// the first and last. Picks indices on a uniform stride so the replay keeps the shape of the track.</summary>
    private static List<UserLocation> Downsample(List<UserLocation> ordered, int max)
    {
        if (ordered.Count <= max) return ordered;
        if (max <= 1) return ordered.Count == 0 ? ordered : new List<UserLocation> { ordered[^1] };

        var picked = new List<UserLocation>(max);
        // Spread max-1 steps across the span [0, count-1] so index 0 and count-1 are both hit exactly.
        var step = (double)(ordered.Count - 1) / (max - 1);
        var lastIdx = -1;
        for (var i = 0; i < max; i++)
        {
            var idx = (int)Math.Round(i * step);
            if (idx <= lastIdx) idx = lastIdx + 1; // guard against a duplicate from rounding
            if (idx >= ordered.Count) break;
            picked.Add(ordered[idx]);
            lastIdx = idx;
        }
        return picked;
    }
}
