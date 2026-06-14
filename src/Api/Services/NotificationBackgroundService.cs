using Ccusage.Api.Data;
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

        // Daily digest → the previous full day, at most once per day.
        if (s.DailyDigest && s.LastDailySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var day = today.AddDays(-1);
            var sum = await notifier.SummarizeAsync(day, day, ct);
            // No activity → nothing to post, but still mark done so we don't re-summarize every minute.
            var done = sum.Messages == 0 || await notifier.SendDigestAsync(url, $"Daily usage — {day:MMM d}", sum, ct);
            if (done) { s.LastDailySent = today; await db.SaveChangesAsync(ct); }
        }

        // Weekly digest → previous 7 days, on the configured weekday, at most once that day.
        if (s.WeeklyDigest && (int)nowLocal.DayOfWeek == s.WeeklyDay
            && s.LastWeeklySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var from = today.AddDays(-7);
            var to = today.AddDays(-1);
            var sum = await notifier.SummarizeAsync(from, to, ct);
            var done = sum.Messages == 0 || await notifier.SendDigestAsync(url, $"Weekly usage — {from:MMM d}–{to:MMM d}", sum, ct);
            if (done) { s.LastWeeklySent = today; await db.SaveChangesAsync(ct); }
        }

        // Spend threshold → at most one alert per day, when today's running spend crosses it.
        if (s.ThresholdEnabled && s.ThresholdUsd > 0 && s.LastThresholdSent != today)
        {
            var sum = await notifier.SummarizeAsync(today, today, ct);
            if (sum.Cost >= s.ThresholdUsd
                && await notifier.SendThresholdAsync(url, today, sum.Cost, s.ThresholdUsd, ct))
            {
                s.LastThresholdSent = today;
                await db.SaveChangesAsync(ct);
            }
        }
    }

    private static async Task<TimeZoneInfo> ResolveTzAsync(UsageDbContext db, CancellationToken ct)
    {
        var tzId = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        if (string.IsNullOrWhiteSpace(tzId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tzId); }
        catch { return TimeZoneInfo.Utc; }
    }
}
