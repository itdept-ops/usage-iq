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
        // Manage the Discord integration. Gated by settings.manage; the webhook URL is a secret,
        // so it is never returned in full (masked on read) and its PUT body is redacted in the action log.
        var g = app.MapGroup("/api/notifications")
            .RequireAuthorization().RequirePermission(Permissions.SettingsManage);

        g.MapGet("/", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok(ToDto(await db.NotificationSettings.AsNoTracking().FirstOrDefaultAsync(ct)
                              ?? new NotificationSetting { Id = 1 })));

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

            s.Enabled = req.Enabled;
            s.DigestHourLocal = Math.Clamp(req.DigestHourLocal, 0, 23);
            s.DailyDigest = req.DailyDigest;
            s.WeeklyDigest = req.WeeklyDigest;
            s.WeeklyDay = Math.Clamp(req.WeeklyDay, 0, 6);
            s.ThresholdEnabled = req.ThresholdEnabled;
            s.ThresholdUsd = Math.Max(0, req.ThresholdUsd);

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(s));
        });

        g.MapPost("/test", async (UsageDbContext db, DiscordNotifier notifier, CancellationToken ct) =>
        {
            var s = await db.NotificationSettings.AsNoTracking().FirstOrDefaultAsync(ct);
            if (s is null || !DiscordNotifier.IsValidWebhook(s.DiscordWebhookUrl))
                return Results.BadRequest(new { message = "Save a valid Discord webhook URL first." });

            return await notifier.SendTestAsync(s.DiscordWebhookUrl!, ct)
                ? Results.Ok(new { message = "Test message sent to Discord." })
                : Results.Json(new { message = "Discord rejected the message — double-check the webhook URL." },
                    statusCode: StatusCodes.Status502BadGateway);
        }).RequireRateLimiting("notif-test");
    }

    private static NotificationSettingDto ToDto(NotificationSetting s) => new()
    {
        WebhookConfigured = !string.IsNullOrEmpty(s.DiscordWebhookUrl),
        WebhookMasked = Mask(s.DiscordWebhookUrl),
        Enabled = s.Enabled,
        DigestHourLocal = s.DigestHourLocal,
        DailyDigest = s.DailyDigest,
        WeeklyDigest = s.WeeklyDigest,
        WeeklyDay = s.WeeklyDay,
        ThresholdEnabled = s.ThresholdEnabled,
        ThresholdUsd = s.ThresholdUsd,
    };

    private static string? Mask(string? url)
    {
        if (string.IsNullOrEmpty(url)) return null;
        var tail = url.Length <= 4 ? url : url[^4..];
        return $"discord.com/api/webhooks/…{tail}";
    }
}
