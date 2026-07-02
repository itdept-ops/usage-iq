using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Web Push (background notification) subscription management + the public VAPID key.
///
/// <para><c>GET  /api/push/vapid-public</c> — ANON by design: hands the browser the PUBLIC VAPID key so it
/// can create a push subscription. 404 when web-push is unconfigured. (Only the PUBLIC key — the private
/// key never leaves the server.)</para>
/// <para><c>POST /api/push/subscribe</c> — caller-scoped: upsert THIS user's subscription by endpoint
/// (owner taken from the JWT, never the body). Re-subscribing the same device updates its keys/owner.</para>
/// <para><c>DELETE /api/push/subscribe</c> — caller-scoped: remove the caller's own subscription by endpoint.</para>
///
/// <para>Authenticated routes are gated by <c>chat.read</c> — the same page-view gate the inbox/notification
/// prefs use, since web-push is a delivery surface for those notifications.</para>
/// </summary>
public static class PushEndpoints
{
    public static void MapPushEndpoints(this WebApplication app)
    {
        // ---- PUBLIC: the VAPID public key the client needs to subscribe (anon by design) ----
        app.MapGet("/api/push/vapid-public", (IOptions<WebPushOptions> opts) =>
        {
            var o = opts.Value;
            // Unconfigured ⇒ 404 so the client treats web-push as unavailable and never tries to subscribe.
            // Only the PUBLIC key is ever returned; the private key is never exposed on any endpoint.
            return o.IsConfigured
                ? Results.Ok(new { publicKey = o.PublicKey })
                : Results.NotFound(new { message = "Web push is not configured." });
        }).AllowAnonymous();

        var g = app.MapGroup("/api/push").RequireAuthorization().RequirePermission(Permissions.ChatRead);

        // ---- Upsert the caller's subscription (owner from the JWT, never the body) ----
        g.MapPost("/subscribe", async (
            PushSubscribeRequest req, CurrentUserAccessor me, UsageDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;

            var endpoint = (req.Endpoint ?? "").Trim();
            var p256dh = (req.Keys?.P256dh ?? "").Trim();
            var auth = (req.Keys?.Auth ?? "").Trim();
            if (endpoint.Length == 0 || p256dh.Length == 0 || auth.Length == 0)
                return Results.BadRequest(new { message = "endpoint and keys.p256dh/keys.auth are required." });
            // Cap to the column sizes so an oversized blob is rejected cleanly rather than truncated/throwing.
            if (endpoint.Length > 1024 || p256dh.Length > 256 || auth.Length > 256)
                return Results.BadRequest(new { message = "Subscription fields are too long." });
            // Reject at STORE time anything that isn't an https URL at a legitimate browser push host — the same
            // allowlist WebPushSender enforces at SEND time. Storing only trusted endpoints closes off SSRF via a
            // forged endpoint (internal/metadata hosts, bare IPs, http) instead of relying on the send-time filter.
            if (!IsAllowedPushEndpoint(endpoint))
                return Results.BadRequest(new { message = "endpoint is not a supported push service URL." });

            var ua = http.Request.Headers.UserAgent.ToString();
            if (ua.Length > 512) ua = ua[..512];

            // Upsert by endpoint. The endpoint is globally unique (a device's push token); if it already
            // exists we re-key it to THIS caller + refresh the keys (a device can only belong to one user at
            // a time, and a re-subscribe may rotate the keys). Owner ALWAYS comes from the JWT.
            var existing = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.Endpoint == endpoint, ct);
            if (existing is null)
            {
                db.PushSubscriptions.Add(new Data.Entities.PushSubscription
                {
                    OwnerEmail = user.Email,
                    Endpoint = endpoint,
                    P256dh = p256dh,
                    Auth = auth,
                    UserAgent = string.IsNullOrWhiteSpace(ua) ? null : ua,
                    CreatedUtc = DateTime.UtcNow,
                });
            }
            else
            {
                existing.OwnerEmail = user.Email;
                existing.P256dh = p256dh;
                existing.Auth = auth;
                if (!string.IsNullOrWhiteSpace(ua)) existing.UserAgent = ua;
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (ChatEndpoints.IsUniqueViolation(ex))
            {
                // A concurrent subscribe of the SAME endpoint won the unique race — converge by updating the
                // winning row to this caller (idempotent: both racers end with the same owner + keys).
                db.ChangeTracker.Clear();
                await db.PushSubscriptions
                    .Where(s => s.Endpoint == endpoint)
                    .ExecuteUpdateAsync(u => u
                        .SetProperty(s => s.OwnerEmail, user.Email)
                        .SetProperty(s => s.P256dh, p256dh)
                        .SetProperty(s => s.Auth, auth), ct);
            }

            return Results.Ok(new { ok = true });
        });

        // ---- Remove the caller's own subscription by endpoint ----
        g.MapDelete("/subscribe", async (
            string? endpoint, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var ep = (endpoint ?? "").Trim();
            if (ep.Length == 0)
                return Results.BadRequest(new { message = "endpoint is required." });

            // Caller-scoped: only the caller's OWN subscription for this endpoint is removed (never another
            // user's). A no-match (already gone / not theirs) is a friendly idempotent success.
            await db.PushSubscriptions
                .Where(s => s.OwnerEmail == user.Email && s.Endpoint == ep)
                .ExecuteDeleteAsync(ct);
            return Results.Ok(new { ok = true });
        });
    }

    // The ONLY hosts a browser push endpoint may point at — kept in lock-step with WebPushSender's send-time
    // allowlist (fcm.googleapis.com / web.push.apple.com plus Mozilla/WNS regional-shard suffixes). Validating
    // here at store time means a forged endpoint never even reaches the database, not just the sender.
    private static readonly HashSet<string> AllowedPushHosts =
        new(StringComparer.OrdinalIgnoreCase) { "fcm.googleapis.com", "web.push.apple.com" };

    private static readonly string[] AllowedPushHostSuffixes =
    {
        ".push.services.mozilla.com",
        ".notify.windows.com",
        ".wns.windows.com",
    };

    /// <summary>
    /// True only for an https URL whose host is a known browser push service. Everything else — http, a bare
    /// IP, an internal/metadata host, or an unknown domain — is rejected so a user-supplied endpoint can never
    /// be stored (and later POSTed to) as an SSRF target. Mirrors WebPushSender.IsAllowedPushEndpoint.
    /// </summary>
    private static bool IsAllowedPushEndpoint(string? endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps) return false;
        if (u.HostNameType is UriHostNameType.IPv4 or UriHostNameType.IPv6) return false;
        if (AllowedPushHosts.Contains(u.Host)) return true;
        foreach (var suffix in AllowedPushHostSuffixes)
            if (u.Host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}

/// <summary>The browser's PushSubscription JSON shape: an endpoint URL + the p256dh/auth encryption keys.</summary>
public sealed class PushSubscribeRequest
{
    public string? Endpoint { get; set; }
    public PushSubscribeKeys? Keys { get; set; }
}

public sealed class PushSubscribeKeys
{
    public string? P256dh { get; set; }
    public string? Auth { get; set; }
}
