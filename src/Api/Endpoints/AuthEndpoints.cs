using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this WebApplication app)
    {
        var auth = app.MapGroup("/api/auth");

        // Public: the SPA fetches the client id to initialize Google Identity Services.
        auth.MapGet("/config", (IConfiguration cfg) =>
                Results.Ok(new AuthConfigDto { GoogleClientId = cfg["Google:ClientId"] ?? "" }))
            .AllowAnonymous();

        // Public: exchange a Google ID token for an app JWT (allowlist enforced server-side).
        auth.MapPost("/google", async (GoogleLoginRequest req, GoogleAuthService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.IdToken))
                return Results.BadRequest(new { message = "idToken is required" });

            var result = await svc.SignInAsync(req.IdToken, ct);
            return result.Status switch
            {
                SignInStatus.Ok => Results.Ok(result.Auth),
                SignInStatus.Forbidden => Results.Json(
                    new { message = $"{result.Email} is not authorized to access Usage IQ.", email = result.Email },
                    statusCode: StatusCodes.Status403Forbidden),
                _ => Results.Unauthorized(),
            };
        }).AllowAnonymous().RequireRateLimiting("auth");

        // Authorized: current user + live permissions (re-read from the DB).
        auth.MapGet("/me", async (CurrentUserAccessor accessor, CancellationToken ct) =>
        {
            var u = await accessor.GetUserAsync(ct);
            if (u is null || !u.IsEnabled)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            return Results.Ok(new MeDto
            {
                UserId = u.Id,
                Email = u.Email,
                Name = u.Name,
                Picture = u.Picture,
                IsEnabled = u.IsEnabled,
                Permissions = u.Permissions.ToArray(),
                HomeRoute = u.HomeRoute,
                DisplayNameMode = DisplayName.ModeToWire(u.DisplayNameMode),
                Nickname = u.Nickname,
                AppearOffline = u.AppearOffline,
                PresenceStatus = u.PresenceStatus,
                ShareAutoContext = u.ShareAutoContext,
                ShareActivity = u.ShareActivity,
                ViewActivityFeed = u.ViewActivityFeed,
                NudgesOptOut = u.NudgesOptOut,
            });
        }).RequireAuthorization();

        // Self-service: update the CALLER's OWN display/presence preferences (how THEY appear to everyone,
        // their appear-offline toggle, their status + auto-context opt-in). Authentication only — never
        // users.manage; a user can only ever change their own row. Partial: only non-null fields apply.
        // Nickname/status are sanitized server-side (never an email). Returns the fresh effective values.
        auth.MapPatch("/profile", async (SetProfileRequest req, CurrentUserAccessor accessor, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = await accessor.GetUserAsync(ct);
            if (caller is null || !caller.IsEnabled)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            var user = await db.Users.FirstOrDefaultAsync(x => x.Id == caller.Id, ct);
            if (user is null)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            if (req.DisplayNameMode is not null)
            {
                if (!DisplayName.TryParseMode(req.DisplayNameMode, out var mode))
                    return Results.BadRequest(new { message = $"'{req.DisplayNameMode}' is not a valid display-name mode." });
                user.DisplayNameMode = mode;
            }

            // Empty string clears; any other value is sanitized (control chars / '@' / length capped).
            if (req.Nickname is not null)
                user.Nickname = DisplayName.SanitizeNickname(req.Nickname);
            if (req.PresenceStatus is not null)
                user.PresenceStatus = DisplayName.SanitizeStatus(req.PresenceStatus);
            if (req.AppearOffline is { } off) user.AppearOffline = off;
            if (req.ShareAutoContext is { } share) user.ShareAutoContext = share;
            if (req.ShareActivity is { } shareAct) user.ShareActivity = shareAct;
            if (req.ViewActivityFeed is { } viewFeed) user.ViewActivityFeed = viewFeed;
            if (req.NudgesOptOut is { } nudgeOut) user.NudgesOptOut = nudgeOut;

            await db.SaveChangesAsync(ct);

            return Results.Ok(new
            {
                displayNameMode = DisplayName.ModeToWire(user.DisplayNameMode),
                nickname = user.Nickname,
                appearOffline = user.AppearOffline,
                presenceStatus = user.PresenceStatus,
                shareAutoContext = user.ShareAutoContext,
                shareActivity = user.ShareActivity,
                viewActivityFeed = user.ViewActivityFeed,
                nudgesOptOut = user.NudgesOptOut,
            });
        }).RequireAuthorization();

        // Self-service: set (or clear) the CALLER's own landing page. Gated by authentication only —
        // every signed-in user may set their OWN home (never users.manage). The route must be null (clear)
        // or one of the known page routes AND one the caller currently has permission to reach, so a user
        // can never persist a home they cannot access.
        auth.MapPatch("/home", async (SetHomeRequest req, CurrentUserAccessor accessor, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = await accessor.GetUserAsync(ct);
            if (caller is null || !caller.IsEnabled)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            var route = string.IsNullOrWhiteSpace(req.Route) ? null : req.Route.Trim();

            if (route is not null)
            {
                if (!HomeRoutes.IsKnown(route))
                    return Results.BadRequest(new { message = $"'{route}' is not a valid home route." });
                if (!HomeRoutes.CanAccess(route, caller.Permissions))
                    return Results.BadRequest(new { message = "You do not have access to that page." });
            }

            // Re-load the tracked row (the accessor reads AsNoTracking) and persist the caller's own home.
            var user = await db.Users.FirstOrDefaultAsync(x => x.Id == caller.Id, ct);
            if (user is null)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            user.HomeRoute = route;
            await db.SaveChangesAsync(ct);

            return Results.Ok(new { homeRoute = route });
        }).RequireAuthorization();
    }
}
