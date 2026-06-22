using Ccusage.Api.Auth;
using Ccusage.Api.Data;
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
                    u.Id, u.Email, u.Name, u.LocationShareHousehold,
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
                        Name = string.IsNullOrWhiteSpace(owner?.Name) ? "Unknown user" : owner!.Name,
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
    }
}
