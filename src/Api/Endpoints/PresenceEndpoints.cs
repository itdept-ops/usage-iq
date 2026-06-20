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

                // One DB round-trip: resolve the online emails to {Id, Name, Picture} public identity.
                var emails = online.Select(e => e.Email).ToArray();
                var users = await db.Users.AsNoTracking()
                    .Where(u => emails.Contains(u.Email))
                    .Select(u => new { u.Id, u.Email, u.Name, u.Picture })
                    .ToListAsync(ct);
                var byEmail = users.ToDictionary(u => u.Email, StringComparer.OrdinalIgnoreCase);

                var result = online
                    .Select(e =>
                    {
                        byEmail.TryGetValue(e.Email, out var u);
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
                            IsSelf = callerEmail is not null
                                     && string.Equals(e.Email, callerEmail, StringComparison.OrdinalIgnoreCase),
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
