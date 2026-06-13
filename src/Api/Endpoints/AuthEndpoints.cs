using Ccusage.Api.Auth;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;

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
        }).AllowAnonymous();

        // Authorized: current user + live permissions (re-read from the DB).
        auth.MapGet("/me", async (CurrentUserAccessor accessor, CancellationToken ct) =>
        {
            var u = await accessor.GetUserAsync(ct);
            if (u is null || !u.IsEnabled)
                return Results.Json(new { message = "Your account is not provisioned or has been disabled." },
                    statusCode: StatusCodes.Status403Forbidden);

            return Results.Ok(new MeDto
            {
                Email = u.Email,
                Name = u.Name,
                IsEnabled = u.IsEnabled,
                Permissions = u.Permissions.ToArray(),
            });
        }).RequireAuthorization();
    }
}
