using System.Security.Claims;
using Ccusage.Api.Services;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// On every <em>authenticated</em> request, stamps the caller as currently online in the in-memory
/// <see cref="PresenceTracker"/>. Reads the JWT's literal "email"/"name"/"picture" claims
/// (Program.cs sets MapInboundClaims=false, so claim types are not remapped to URIs).
///
/// Best-effort: it never throws and never short-circuits the request — presence is a nicety, not a
/// gate. Registered AFTER UseAuthentication/UseAuthorization so <c>User</c> is populated, and because
/// the SPA already polls /me + /sync/status every ~15-20s, this keeps presence fresh with no
/// dedicated client heartbeat.
/// </summary>
public sealed class PresenceMiddleware(RequestDelegate next, PresenceTracker presence)
{
    public async Task Invoke(HttpContext ctx)
    {
        try
        {
            if (ctx.User.Identity?.IsAuthenticated == true)
            {
                var email = ctx.User.FindFirstValue("email");
                if (!string.IsNullOrWhiteSpace(email))
                    presence.Touch(email, ctx.User.FindFirstValue("name"), ctx.User.FindFirstValue("picture"));
            }
        }
        catch
        {
            // Never let presence bookkeeping disturb the request.
        }

        await next(ctx);
    }
}
