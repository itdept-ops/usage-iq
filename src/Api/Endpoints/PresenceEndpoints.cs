using Ccusage.Api.Dtos;
using Ccusage.Api.Services;

namespace Ccusage.Api.Endpoints;

public static class PresenceEndpoints
{
    public static void MapPresenceEndpoints(this WebApplication app)
    {
        // Who's online right now (active within the last 2 minutes). Any signed-in user may see their
        // online teammates — the caller themselves is included (this very request marks them present).
        app.MapGet("/api/presence", (PresenceTracker presence) =>
            {
                var online = presence.Online(PresenceTracker.DefaultWindow)
                    .Select(e => new PresenceDto
                    {
                        Email = e.Email,
                        Name = e.Name,
                        Picture = e.Picture,
                        LastSeenUtc = e.LastSeenUtc,
                    })
                    .ToList();

                return Results.Ok(online);
            })
            .RequireAuthorization();
    }
}
