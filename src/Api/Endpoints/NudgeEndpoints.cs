using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Peer NUDGES (<c>POST /api/nudge</c>): send a circle peer a canned, safe ping ("log your day", "close
/// your rings", "keep the streak", "check-in"). ADDITIVE + READ-of-existing: it composes the SAME building
/// blocks the live surfaces use (<see cref="ContactGraph"/> for the circle, the household-member join the
/// People hub uses, and the shared <see cref="ChatNotificationService"/> notification path) without
/// changing any of their behavior.
///
/// ABUSE/PRIVACY MODEL (strict, all enforced here):
/// <list type="bullet">
///   <item><b>Circle-gated.</b> The target MUST be a mutual contact OR a fellow household member of the
///   caller. A stranger — or yourself — is rejected. To never leak whether a stranger exists, a non-circle
///   / unknown / self target is a flat <b>404</b> (same stance as the leaderboard/feed reads).</item>
///   <item><b>No free-text.</b> The body carries ONLY a fixed <see cref="NudgeKind"/>; the notification text
///   is a server-side template keyed by that kind. An unknown kind is a <b>400</b>. There is no path for
///   client text into a notification — no injection, no @-mentions.</item>
///   <item><b>Opt-out.</b> A target who set <see cref="AppUser.NudgesOptOut"/> gets nothing — a friendly
///   200 no-op (NOT a distinguishing error) so opt-out is not observable.</item>
///   <item><b>Rate-limited + cooldowned.</b> The global per-account "chat" policy caps the sender; on top of
///   that a per-(sender, target) COOLDOWN (<see cref="CooldownWindow"/>) makes a rapid repeat a friendly
///   200 no-op — NO second notification — so it can't be used to spam/harass.</item>
/// </list>
/// AUTH: <see cref="Permissions.ChatSend"/> (the same trust class as posting a message / starting a DM).
/// </summary>
public static class NudgeEndpoints
{
    /// <summary>Per-(sender, target) cooldown: at most one nudge to a given person every 2 hours.</summary>
    public static readonly TimeSpan CooldownWindow = TimeSpan.FromHours(2);

    public static void MapNudgeEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/nudge").RequireAuthorization();

        // POST /api/nudge { targetUserId, kind } — nudge a circle peer with a canned template.
        g.MapPost("/", async (
                NudgeRequest req, CurrentUserAccessor me, ChatNotificationService notifier,
                UsageDbContext db, CancellationToken ct) =>
            {
                var caller = (await me.GetUserAsync(ct))!; // chat.send filter guarantees non-null

                // Validate the kind FIRST (no free-text; unknown ⇒ 400, before any existence check).
                if (!TryParseKind(req.Kind, out var kind))
                    return Results.BadRequest(new { message = $"'{req.Kind}' is not a valid nudge." });

                // Reject self up front (you can't nudge yourself) — flat 404, never leak.
                if (req.TargetUserId <= 0 || req.TargetUserId == caller.Id)
                    return Results.NotFound();

                // Resolve the target id -> internal email (enabled users only). Absent ⇒ 404.
                var emailById = await ChatNotificationService.ResolveEmailsByIdAsync(db, new[] { req.TargetUserId }, ct);
                if (!emailById.TryGetValue(req.TargetUserId, out var targetEmailRaw))
                    return Results.NotFound();
                var targetEmail = targetEmailRaw.ToLowerInvariant();

                // Circle authorization: a mutual contact OR a fellow household member. Else 404 (no leak).
                if (!await InCircleAsync(db, caller, targetEmail, ct))
                    return Results.NotFound();

                // Per-(sender, target) COOLDOWN: a repeat inside the window is a friendly no-op — NO second
                // notification. (The global "chat" rate-limit policy is the per-account flood cap on top.)
                var since = DateTime.UtcNow - CooldownWindow;
                var onCooldown = await db.NudgeEvents.AsNoTracking().AnyAsync(
                    n => n.SenderEmail == caller.Email && n.TargetEmail == targetEmail && n.CreatedUtc > since, ct);
                if (onCooldown)
                    return Results.Ok(new { delivered = false, reason = "cooldown" });

                // Deliver ONE notification (honors the target's opt-out; no-op + no audit row if opted out).
                var delivered = await notifier.NotifyNudgeAsync(req.TargetUserId, caller.Email, kind, ct);
                if (!delivered)
                    return Results.Ok(new { delivered = false, reason = "unavailable" });

                // Record the audit/cooldown row only on a real delivery.
                db.NudgeEvents.Add(new NudgeEvent
                {
                    SenderEmail = caller.Email.ToLowerInvariant(),
                    TargetEmail = targetEmail,
                    Kind = kind,
                    CreatedUtc = DateTime.UtcNow,
                });
                await db.SaveChangesAsync(ct);

                return Results.Ok(new { delivered = true });
            })
            .RequirePermission(Permissions.ChatSend)
            .RequireRateLimiting("chat");
    }

    /// <summary>Whether <paramref name="targetEmail"/> is in <paramref name="caller"/>'s circle: a mutual
    /// contact OR a fellow member of the caller's household. Mirrors the People hub's union of the two
    /// sources, so the UI's nudge button (shown on exactly that set) never offers a button that 404s.</summary>
    private static async Task<bool> InCircleAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, string targetEmail, CancellationToken ct)
    {
        if (await ContactGraph.IsContactAsync(db, caller.Email, targetEmail, ct)) return true;

        // Household co-membership (resolved inline, exactly as PeopleEndpoints does it).
        var householdId = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.UserId == caller.Id)
            .Select(m => (int?)m.HouseholdId)
            .FirstOrDefaultAsync(ct);
        if (householdId is not int hid) return false;

        return await db.HouseholdMembers.AsNoTracking()
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new { m.HouseholdId, u.Email })
            .AnyAsync(x => x.HouseholdId == hid && x.Email == targetEmail, ct);
    }

    /// <summary>Parse the camelCase wire kind to the fixed <see cref="NudgeKind"/>; false on anything else
    /// (no free-text accepted). The accepted names mirror the enum members in camelCase.</summary>
    private static bool TryParseKind(string? raw, out NudgeKind kind)
    {
        kind = default;
        switch ((raw ?? "").Trim())
        {
            case "logYourDay": kind = NudgeKind.LogYourDay; return true;
            case "closeYourRings": kind = NudgeKind.CloseYourRings; return true;
            case "keepTheStreak": kind = NudgeKind.KeepTheStreak; return true;
            case "checkIn": kind = NudgeKind.CheckIn; return true;
            default: return false;
        }
    }

    /// <summary>The nudge request: the target by AppUser id (email-privacy) + a fixed kind (camelCase).</summary>
    public sealed class NudgeRequest
    {
        public int TargetUserId { get; set; }
        public string? Kind { get; set; }
    }
}
