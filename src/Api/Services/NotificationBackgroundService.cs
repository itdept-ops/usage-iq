using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Ticks once a minute and sends the configured Discord digests/alerts at their scheduled local time.
/// "Last sent" guards on the settings row make each send at-most-once-per-day despite the frequent tick.
/// </summary>
public sealed class NotificationBackgroundService(
    IServiceScopeFactory scopeFactory, ILogger<NotificationBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        do
        {
            try { await TickAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogError(ex, "Notification scheduler tick failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task TickAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var notifier = scope.ServiceProvider.GetRequiredService<DiscordNotifier>();

        var s = await db.NotificationSettings.FirstOrDefaultAsync(ct);
        if (s is null || !s.Enabled || !DiscordNotifier.IsValidWebhook(s.DiscordWebhookUrl)) return;

        var tz = await ResolveTzAsync(db, ct);
        var nowLocal = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, tz);
        var today = DateOnly.FromDateTime(nowLocal.DateTime);
        var url = s.DiscordWebhookUrl!;

        // Use ">= hour" (not "== hour") so a restart that spans the configured minute still sends later
        // that day rather than dropping the digest forever; this also makes a non-existent DST hour harmless.
        // The guard only advances on a *successful* send, so a transient Discord/DB failure retries next tick.

        // Daily digest → the previous full day, with a trend vs the day before.
        if (s.DailyDigest && s.LastDailySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var day = today.AddDays(-1);
            var d = await notifier.BuildDigestAsync(day, day, day.AddDays(-1), day.AddDays(-1), ct);
            var done = d.Messages == 0 || await notifier.SendDigestAsync(url, $"Daily usage — {day:MMM d}", d, ct);
            if (done) { s.LastDailySent = today; await db.SaveChangesAsync(ct); }
        }

        // Weekly digest → previous 7 days, with a trend vs the 7 days before that.
        if (s.WeeklyDigest && (int)nowLocal.DayOfWeek == s.WeeklyDay
            && s.LastWeeklySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var from = today.AddDays(-7);
            var to = today.AddDays(-1);
            var d = await notifier.BuildDigestAsync(from, to, from.AddDays(-7), from.AddDays(-1), ct);
            var done = d.Messages == 0 || await notifier.SendDigestAsync(url, $"Weekly usage — {from:MMM d}–{to:MMM d}", d, ct);
            if (done) { s.LastWeeklySent = today; await db.SaveChangesAsync(ct); }
        }

        // Spend threshold → at most one alert per day, when today's running spend crosses it.
        if (s.ThresholdEnabled && s.ThresholdUsd > 0 && s.LastThresholdSent != today)
        {
            var sum = await notifier.SummarizeAsync(today, today, ct);
            if (sum.Cost >= s.ThresholdUsd
                && await notifier.SendThresholdAsync(url, today, sum.Cost, s.ThresholdUsd, s.MentionOnAlert, ct))
            {
                s.LastThresholdSent = today;
                await db.SaveChangesAsync(ct);
            }
        }

        // Security alerts → forward audit entries created since the last forwarded id.
        if (s.SecurityAlerts)
            await ForwardSecurityAsync(db, notifier, s, url, ct);
    }

    private static async Task ForwardSecurityAsync(
        UsageDbContext db, DiscordNotifier notifier, NotificationSetting s, string url, CancellationToken ct)
    {
        // The baseline (LastAuditAlertId) is set when security alerts are turned on, so history isn't replayed.
        var newEntries = await db.AuditEntries.AsNoTracking()
            .Where(a => a.Id > s.LastAuditAlertId).OrderBy(a => a.Id).Take(20).ToListAsync(ct);
        if (newEntries.Count == 0) return;

        foreach (var e in newEntries)
        {
            // Never let an auth.* event carry the @everyone/@here mention — those can be triggered by
            // outside parties; reserve pings for admin-initiated user.* management changes.
            var mention = e.Action.StartsWith("auth.", StringComparison.Ordinal) ? null : s.MentionOnAlert;
            if (!await notifier.SendSecurityAsync(url, e.Action, e.ActorEmail, e.TargetEmail, e.Detail, mention, ct))
                break; // stop on failure; retry from here next tick
            s.LastAuditAlertId = e.Id;
        }
        await db.SaveChangesAsync(ct);
    }

    private static async Task<TimeZoneInfo> ResolveTzAsync(UsageDbContext db, CancellationToken ct)
    {
        var tzId = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        if (string.IsNullOrWhiteSpace(tzId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tzId); }
        catch { return TimeZoneInfo.Utc; }
    }
}
