using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class NotificationsEndpoints
{
    public static void MapNotificationsEndpoints(this WebApplication app)
    {
        // Manage the Discord integration. Gated by notifications.*; the webhook URL is a secret,
        // so it is never returned in full (masked on read) and its PUT body is redacted in the action log.
        var g = app.MapGroup("/api/notifications").RequireAuthorization();

        g.MapGet("/", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok(ToDto(await db.NotificationSettings.AsNoTracking().FirstOrDefaultAsync(ct)
                              ?? new NotificationSetting { Id = 1 })))
            .RequireAnyPermission(Permissions.NotificationsView, Permissions.NotificationsManage);

        g.MapPut("/", async (NotificationUpdateRequest req, UsageDbContext db, CancellationToken ct) =>
        {
            var s = await db.NotificationSettings.FirstOrDefaultAsync(ct);
            if (s is null) { s = new NotificationSetting { Id = 1 }; db.NotificationSettings.Add(s); }

            if (req.DiscordWebhookUrl is not null)
            {
                var url = req.DiscordWebhookUrl.Trim();
                if (url.Length == 0) s.DiscordWebhookUrl = null;
                else if (DiscordNotifier.IsValidWebhook(url)) s.DiscordWebhookUrl = url;
                else return Results.BadRequest(new { message = "Enter a valid Discord webhook URL (https://discord.com/api/webhooks/…)." });
            }

            // NotificationSetting keeps the WEBHOOK + global Enabled + digest SCHEDULE (hour/day) + threshold
            // VALUE + global mention. WHICH events forward (daily/weekly/threshold/security) now lives in the
            // DiscordRoute routing table (PUT /routes/{eventKey}), not these booleans.
            s.Enabled = req.Enabled;
            s.DigestHourLocal = Math.Clamp(req.DigestHourLocal, 0, 23);
            s.WeeklyDay = Math.Clamp(req.WeeklyDay, 0, 6);
            s.ThresholdUsd = Math.Max(0, req.ThresholdUsd);
            var mention = req.MentionOnAlert?.Trim();
            s.MentionOnAlert = string.IsNullOrEmpty(mention) ? null : (mention.Length > 64 ? mention[..64] : mention);

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(s));
        }).RequirePermission(Permissions.NotificationsManage);

        g.MapPost("/test", async (UsageDbContext db, DiscordNotifier notifier, CancellationToken ct) =>
        {
            var s = await db.NotificationSettings.AsNoTracking().FirstOrDefaultAsync(ct);
            if (s is null || !DiscordNotifier.IsValidWebhook(s.DiscordWebhookUrl))
                return Results.BadRequest(new { message = "Save a valid Discord webhook URL first." });

            return await notifier.SendTestAsync(s.DiscordWebhookUrl!, ct)
                ? Results.Ok(new { message = "Test message sent to Discord." })
                : Results.Json(new { message = "Discord rejected the message — double-check the webhook URL." },
                    statusCode: StatusCodes.Status502BadGateway);
        }).RequirePermission(Permissions.NotificationsManage).RequireRateLimiting("notif-test");

        // Post a current-usage snapshot (today / 7d / month / all-time) to Discord on demand.
        g.MapPost("/snapshot", async (UsageDbContext db, DiscordNotifier notifier, CancellationToken ct) =>
        {
            var s = await db.NotificationSettings.AsNoTracking().FirstOrDefaultAsync(ct);
            if (s is null || !DiscordNotifier.IsValidWebhook(s.DiscordWebhookUrl))
                return Results.BadRequest(new { message = "Save a valid Discord webhook URL first." });

            var tzId = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
            var tz = ResolveTz(tzId);
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, tz).DateTime);

            return await notifier.SendSnapshotAsync(s.DiscordWebhookUrl!, today, ct)
                ? Results.Ok(new { message = "Usage snapshot sent to Discord." })
                : Results.Json(new { message = "Discord rejected the message — double-check the webhook URL." },
                    statusCode: StatusCodes.Status502BadGateway);
        }).RequirePermission(Permissions.NotificationsManage).RequireRateLimiting("notif-test");

        // ---- System Discord ROUTING TABLE (admin) ----
        // Which routable system events forward to Discord, and their per-route mention. Reads/writes are
        // gated by the same notifications.manage group; the webhook/global-enable/schedule still live on the
        // singleton NotificationSetting above.
        g.MapGet("/routes", async (UsageDbContext db, CancellationToken ct) =>
        {
            var rows = await db.DiscordRoutes.AsNoTracking().OrderBy(r => r.SortOrder).ToListAsync(ct);
            return Results.Ok(rows.Select(RouteDto));
        }).RequireAnyPermission(Permissions.NotificationsView, Permissions.NotificationsManage);

        g.MapPut("/routes/{eventKey}", async (string eventKey, DiscordRouteUpdateRequest req, UsageDbContext db, CancellationToken ct) =>
        {
            var route = await db.DiscordRoutes.FirstOrDefaultAsync(r => r.EventKey == eventKey, ct);
            if (route is null) return Results.NotFound(new { message = "Unknown routing event." });

            // When the security-alerts route is turned ON, baseline the audit high-water mark so existing
            // history isn't replayed (the same guard the old SecurityAlerts flag had, now route-owned).
            if (eventKey == DiscordRouteKeys.SecurityAlerts && req.Enabled && !route.Enabled)
            {
                var s = await db.NotificationSettings.FirstOrDefaultAsync(ct);
                if (s is not null)
                    s.LastAuditAlertId = await db.AuditEntries.MaxAsync(a => (long?)a.Id, ct) ?? 0;
            }

            route.Enabled = req.Enabled;
            var mention = req.Mention?.Trim();
            route.Mention = string.IsNullOrEmpty(mention) ? null : (mention.Length > 64 ? mention[..64] : mention);
            await db.SaveChangesAsync(ct);
            return Results.Ok(RouteDto(route));
        }).RequirePermission(Permissions.NotificationsManage);

        // ---- PER-USER Discord (the CALLER'S OWN webhook; authenticated, no admin gate) ----
        // A user surfaces their own in-app notifications to their personal Discord. They can only ever
        // read/set/test/clear THEIR OWN — keyed by their email — never another user's. The webhook URL is
        // SSRF-validated + encrypted at rest; responses expose only {configured, hint, surfaceDiscord}.
        var me = app.MapGroup("/api/notifications/me/discord").RequireAuthorization();

        me.MapGet("/", async (CurrentUserAccessor accessor, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await accessor.GetUserAsync(ct))!;
            var pref = await db.NotificationPreferences.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserEmail == user.Email, ct);
            return Results.Ok(MyDiscord(pref));
        });

        me.MapPut("/", async (MyDiscordUpdateRequest req, CurrentUserAccessor accessor, UsageDbContext db, TokenProtector protector, CancellationToken ct) =>
        {
            var user = (await accessor.GetUserAsync(ct))!;
            var pref = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserEmail == user.Email, ct);
            if (pref is null)
            {
                pref = new NotificationPreference { UserEmail = user.Email };
                db.NotificationPreferences.Add(pref);
            }

            // Webhook: null = leave · "" = clear · value = validate (SSRF allowlist) + encrypt + store hint.
            if (req.WebhookUrl is not null)
            {
                var url = req.WebhookUrl.Trim();
                if (url.Length == 0)
                {
                    pref.DiscordWebhookEnc = null;
                    pref.DiscordWebhookHint = null;
                }
                else if (DiscordWebhookValidator.IsValid(url))
                {
                    // Encrypt at rest; persist ONLY the blob + a masked, non-sensitive hint. Never the plaintext.
                    pref.DiscordWebhookEnc = protector.Protect(url);
                    pref.DiscordWebhookHint = DiscordWebhookValidator.Hint(url);
                }
                else
                {
                    return Results.BadRequest(new { message = "Enter a valid Discord webhook URL (https://discord.com/api/webhooks/…)." });
                }
            }

            pref.SurfaceDiscord = req.SurfaceDiscord;
            pref.WeeklyRecapEnabled = req.WeeklyRecapEnabled;
            // null Categories = leave the stored mask unchanged (older clients); otherwise replace it.
            if (req.Categories is not null)
                pref.DiscordCategories = (int)ToCategoryMask(req.Categories);
            pref.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(MyDiscord(pref));
        });

        me.MapPost("/test", async (CurrentUserAccessor accessor, UsageDbContext db, TokenProtector protector, DiscordNotifier notifier, CancellationToken ct) =>
        {
            var user = (await accessor.GetUserAsync(ct))!;
            var pref = await db.NotificationPreferences.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserEmail == user.Email, ct);
            if (pref is null || string.IsNullOrEmpty(pref.DiscordWebhookEnc))
                return Results.NotFound(new { message = "Save your Discord webhook first." });

            var url = protector.Unprotect(pref.DiscordWebhookEnc);
            if (string.IsNullOrEmpty(url) || !DiscordWebhookValidator.IsValid(url))
                return Results.NotFound(new { message = "Save your Discord webhook first." });

            var ok = await notifier.ForwardUserNotificationAsync(
                url!, "directMessage", "Usage IQ",
                "Your personal Discord is wired up — your notifications will land right here.", null, ct);
            return ok.Ok
                ? Results.Ok(new { message = "Test message sent to your Discord." })
                : Results.Json(new { message = "Discord rejected the message — double-check the webhook URL." },
                    statusCode: StatusCodes.Status502BadGateway);
        }).RequireRateLimiting("notif-test");

        // Weekly recap SEND-NOW / preview (the caller's OWN webhook; the SAME auth-only, own-webhook design as
        // /test — a user acting on their own recap, NOT the admin notifications.manage config). With
        // ?preview=true it composes + RETURNS the embed (period/headline/fields) without sending — no webhook
        // needed. Otherwise it sends the last-7-days recap immediately, ignoring the opt-in toggle + the
        // weekly idempotency guard (an explicit user action). 404 if no webhook saved; 502 if Discord rejects.
        me.MapPost("/recap", async (
            bool? preview, CurrentUserAccessor accessor, UsageDbContext db, WeeklyRecapComposer recap, CancellationToken ct) =>
        {
            var user = (await accessor.GetUserAsync(ct))!;
            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var from = today.AddDays(-7);
            var to = today.AddDays(-1);

            if (preview == true)
            {
                var (period, headline, fields) = await recap.PreviewAsync(db, user.Email, from, to, today, ct);
                return Results.Ok(new
                {
                    period,
                    headline,
                    fields = fields.Select(f => new { f.Name, f.Value, f.Inline }),
                });
            }

            return await recap.SendNowAsync(user.Email, from, to, today, ct) switch
            {
                WeeklyRecapComposer.SendNowResult.Sent =>
                    Results.Ok(new { message = "Your weekly recap was sent to Discord." }),
                WeeklyRecapComposer.SendNowResult.NoWebhook =>
                    Results.NotFound(new { message = "Save your Discord webhook first." }),
                _ => Results.Json(new { message = "Discord rejected the message — double-check the webhook URL." },
                    statusCode: StatusCodes.Status502BadGateway),
            };
        }).RequireRateLimiting("notif-test");
    }

    private static DiscordRouteDto RouteDto(DiscordRoute r) => new()
    {
        EventKey = r.EventKey,
        Label = r.Label,
        Enabled = r.Enabled,
        Mention = r.Mention,
        SortOrder = r.SortOrder,
    };

    private static MyDiscordDto MyDiscord(NotificationPreference? p) => new()
    {
        Configured = !string.IsNullOrEmpty(p?.DiscordWebhookEnc),
        Hint = p?.DiscordWebhookHint,
        SurfaceDiscord = p?.SurfaceDiscord ?? false,
        WeeklyRecapEnabled = p?.WeeklyRecapEnabled ?? false,
        // Absent row (or legacy 0 mask) ⇒ the all-on default, mirroring the gate's forward-everything fallback.
        Categories = FromCategoryMask(p?.DiscordCategories ?? (int)DiscordForwardCategory.All),
    };

    /// <summary>Project the seven boolean toggles to the stored <see cref="DiscordForwardCategory"/> bitmask.</summary>
    private static DiscordForwardCategory ToCategoryMask(MyDiscordCategoriesDto c)
    {
        var m = DiscordForwardCategory.None;
        if (c.DirectMessages) m |= DiscordForwardCategory.DirectMessages;
        if (c.Mentions) m |= DiscordForwardCategory.Mentions;
        if (c.ChannelMessages) m |= DiscordForwardCategory.ChannelMessages;
        if (c.SystemEvents) m |= DiscordForwardCategory.SystemEvents;
        if (c.FamilyAlerts) m |= DiscordForwardCategory.FamilyAlerts;
        if (c.Cheers) m |= DiscordForwardCategory.Cheers;
        if (c.Nudges) m |= DiscordForwardCategory.Nudges;
        return m;
    }

    /// <summary>Expand a stored bitmask to the seven boolean toggles. A legacy 0 mask reads as all-on so an
    /// unmigrated/blank row never appears "all off" in the UI (matching the gate's default).</summary>
    private static MyDiscordCategoriesDto FromCategoryMask(int mask)
    {
        var m = mask == 0 ? (int)DiscordForwardCategory.All : mask;
        bool On(DiscordForwardCategory c) => (m & (int)c) != 0;
        return new MyDiscordCategoriesDto
        {
            DirectMessages = On(DiscordForwardCategory.DirectMessages),
            Mentions = On(DiscordForwardCategory.Mentions),
            ChannelMessages = On(DiscordForwardCategory.ChannelMessages),
            SystemEvents = On(DiscordForwardCategory.SystemEvents),
            FamilyAlerts = On(DiscordForwardCategory.FamilyAlerts),
            Cheers = On(DiscordForwardCategory.Cheers),
            Nudges = On(DiscordForwardCategory.Nudges),
        };
    }

    private static NotificationSettingDto ToDto(NotificationSetting s) => new()
    {
        WebhookConfigured = !string.IsNullOrEmpty(s.DiscordWebhookUrl),
        WebhookMasked = Mask(s.DiscordWebhookUrl),
        Enabled = s.Enabled,
        DigestHourLocal = s.DigestHourLocal,
        WeeklyDay = s.WeeklyDay,
        ThresholdUsd = s.ThresholdUsd,
        MentionOnAlert = s.MentionOnAlert,
    };

    private static string? Mask(string? url)
    {
        if (string.IsNullOrEmpty(url)) return null;
        var tail = url.Length <= 4 ? url : url[^4..];
        return $"discord.com/api/webhooks/…{tail}";
    }

    private static TimeZoneInfo ResolveTz(string? tzId)
    {
        if (string.IsNullOrWhiteSpace(tzId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tzId); }
        catch { return TimeZoneInfo.Utc; }
    }
}
