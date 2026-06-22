using System.Security.Claims;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class PresenceEndpoints
{
    public static void MapPresenceEndpoints(this WebApplication app)
    {
        // Who's online right now (active within the presence window). Any signed-in user may see their
        // online teammates — the caller themselves is included (this very request marks them present).
        // Resolves each online email to PUBLIC identity (UserId/Name/Picture) via a single Users lookup;
        // the raw email is NEVER emitted (email-privacy). IsSelf marks the caller's own row.
        app.MapGet("/api/presence", async (PresenceTracker presence, UsageDbContext db, ClaimsPrincipal caller,
                CancellationToken ct) =>
            {
                var online = presence.Online(PresenceTracker.DefaultWindow);
                var callerEmail = caller.FindFirstValue("email")?.Trim().ToLowerInvariant();

                // One DB round-trip: resolve the online emails to public identity + the location-share flag.
                var emails = online.Select(e => e.Email).ToArray();
                var users = await db.Users.AsNoTracking()
                    .Where(u => emails.Contains(u.Email))
                    .Select(u => new { u.Id, u.Email, u.Name, u.Picture, u.LocationShareHousehold })
                    .ToListAsync(ct);
                var byEmail = users.ToDictionary(u => u.Email, StringComparer.OrdinalIgnoreCase);

                // Coarse-city visibility (privacy): a user's latest city is shown to THEMSELVES always, and
                // to fellow household members only when that user shares-to-household. Resolve the caller's
                // household once, then the set of user ids in it, so we can gate each online user's city.
                var callerUserId = callerEmail is not null && byEmail.TryGetValue(callerEmail, out var self)
                    ? (int?)self.Id : null;
                var callerHouseholdId = callerUserId is int cid
                    ? await db.HouseholdMembers.AsNoTracking()
                        .Where(m => m.UserId == cid).Select(m => (int?)m.HouseholdId).FirstOrDefaultAsync(ct)
                    : null;
                var householdUserIds = callerHouseholdId is int hid
                    ? (await db.HouseholdMembers.AsNoTracking()
                        .Where(m => m.HouseholdId == hid).Select(m => m.UserId).ToListAsync(ct)).ToHashSet()
                    : new HashSet<int>();

                var result = online
                    .Select(e =>
                    {
                        byEmail.TryGetValue(e.Email, out var u);
                        var isSelf = callerEmail is not null
                                     && string.Equals(e.Email, callerEmail, StringComparison.OrdinalIgnoreCase);

                        // Show the city to self always; to others only when the user shares-to-household AND
                        // is a member of the caller's household. Otherwise the city is suppressed.
                        var cityVisible = isSelf
                            || (u is not null && u.LocationShareHousehold && householdUserIds.Contains(u.Id));

                        return new PresenceDto
                        {
                            UserId = u?.Id,
                            // Prefer the user-row name; fall back to the tracker entry's name. Defense in
                            // depth: the fallback is scrubbed so an email-shaped name claim can't leak an
                            // address through the "name" field (email-privacy) — real display names are
                            // unaffected.
                            Name = string.IsNullOrWhiteSpace(u?.Name) ? ScrubName(e.Name) : u!.Name,
                            Picture = u?.Picture ?? e.Picture,
                            LastSeenUtc = e.LastSeenUtc,
                            IsSelf = isSelf,
                            City = cityVisible ? e.City : null,
                        };
                    })
                    .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                return Results.Ok(result);
            })
            .RequireAuthorization();

        // Sign-out hook: the SPA calls this as the user logs out so they drop offline immediately instead
        // of lingering until their tracker entry ages out of the presence window. Removes the CALLER only
        // (keyed off the JWT email — never echoed back).
        app.MapPost("/api/presence/offline", (PresenceTracker presence, ClaimsPrincipal caller) =>
            {
                presence.Remove(caller.FindFirstValue("email"));
                return Results.NoContent();
            })
            .RequireAuthorization();
    }

    /// <summary>The presence fallback display name: when no AppUser supplied a real name we use the
    /// tracker entry's name, but that name comes from the JWT and could itself be email-shaped. To keep
    /// the response email-free, an address there is reduced to just its local part (before the '@').</summary>
    private static string ScrubName(string name)
    {
        var at = name.IndexOf('@');
        return at < 0 ? name : name[..at];
    }
}
