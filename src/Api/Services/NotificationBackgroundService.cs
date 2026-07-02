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

        // The display timezone is shared by both the admin digests and the per-user recap.
        var tz0 = await ResolveTzAsync(db, ct);
        var nowLocal0 = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, tz0);

        // PERSONAL WEEKLY RECAP — runs INDEPENDENTLY of the admin/global Discord config (different path: each
        // opted-in user posts their OWN week to their OWN webhook). Done first so a disabled/absent admin
        // webhook (the early-return below) never suppresses the per-user recap.
        var recap = scope.ServiceProvider.GetRequiredService<WeeklyRecapComposer>();
        await SendWeeklyRecapsAsync(db, recap, nowLocal0, ct);

        var s = await db.NotificationSettings.FirstOrDefaultAsync(ct);
        if (s is null || !s.Enabled || !DiscordNotifier.IsValidWebhook(s.DiscordWebhookUrl)) return;

        // The per-event routing table replaces the old DailyDigest/WeeklyDigest/ThresholdEnabled/SecurityAlerts
        // booleans: a route's Enabled gates whether that event forwards, and its Mention overrides the global one.
        var routes = await db.DiscordRoutes.AsNoTracking().ToDictionaryAsync(r => r.EventKey, ct);
        bool Enabled(string key) => routes.TryGetValue(key, out var r) && r.Enabled;
        string? RouteMention(string key) => routes.TryGetValue(key, out var r) ? r.Mention : null;

        var nowLocal = nowLocal0;
        var today = DateOnly.FromDateTime(nowLocal.DateTime);
        var url = s.DiscordWebhookUrl!;

        // Use ">= hour" (not "== hour") so a restart that spans the configured minute still sends later
        // that day rather than dropping the digest forever; this also makes a non-existent DST hour harmless.
        // The guard only advances on a *successful* send, so a transient Discord/DB failure retries next tick.

        // Daily digest → the previous full day, with a trend vs the day before.
        if (Enabled(DiscordRouteKeys.DailyDigest) && s.LastDailySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var day = today.AddDays(-1);
            var d = await notifier.BuildDigestAsync(day, day, day.AddDays(-1), day.AddDays(-1), ct);
            var done = d.Messages == 0 || await notifier.SendDigestAsync(url, "Daily", day.ToString("MMM d"), d, ct);
            if (done) { s.LastDailySent = today; await db.SaveChangesAsync(ct); }
        }

        // Weekly digest → previous 7 days, with a trend vs the 7 days before that.
        if (Enabled(DiscordRouteKeys.WeeklyDigest) && (int)nowLocal.DayOfWeek == s.WeeklyDay
            && s.LastWeeklySent != today && nowLocal.Hour >= s.DigestHourLocal)
        {
            var from = today.AddDays(-7);
            var to = today.AddDays(-1);
            var d = await notifier.BuildDigestAsync(from, to, from.AddDays(-7), from.AddDays(-1), ct);
            var done = d.Messages == 0 || await notifier.SendDigestAsync(url, "Weekly", $"{from:MMM d}–{to:MMM d}", d, ct);
            if (done) { s.LastWeeklySent = today; await db.SaveChangesAsync(ct); }
        }

        // Spend threshold → at most one alert per day, when today's running spend crosses it.
        if (Enabled(DiscordRouteKeys.SpendThreshold) && s.ThresholdUsd > 0 && s.LastThresholdSent != today)
        {
            var mention = RouteMention(DiscordRouteKeys.SpendThreshold) ?? s.MentionOnAlert;
            var sum = await notifier.SummarizeAsync(today, today, ct);
            if (sum.Cost >= s.ThresholdUsd
                && await notifier.SendThresholdAsync(url, today, sum.Cost, s.ThresholdUsd, mention, ct))
            {
                s.LastThresholdSent = today;
                await db.SaveChangesAsync(ct);
            }
        }

        // Security alerts + new-user-signup → forward audit entries created since the last forwarded id.
        // Both routes read the same audit stream and advance the same high-water mark; each gates which
        // entries it cares about (security = everything; signup = the user.created/autoprovisioned actions).
        var securityOn = Enabled(DiscordRouteKeys.SecurityAlerts);
        var signupOn = Enabled(DiscordRouteKeys.NewUserSignup);
        if (securityOn || signupOn)
            await ForwardSecurityAsync(db, notifier, s, url, securityOn, signupOn,
                RouteMention(DiscordRouteKeys.SecurityAlerts) ?? s.MentionOnAlert,
                RouteMention(DiscordRouteKeys.NewUserSignup) ?? s.MentionOnAlert, ct);
    }

    /// <summary>The local hour (display tz) at/after which the Sunday recap goes out. ">= hour" (not "==")
    /// so a restart spanning the minute still sends later that day rather than dropping it.</summary>
    private const int RecapHourLocal = 9;

    /// <summary>
    /// PER-USER weekly recap pass: on Sunday at/after <see cref="RecapHourLocal"/> (display tz), every user
    /// who OPTED IN and has a webhook configured, and who hasn't already been sent this week's recap, gets
    /// exactly ONE recap covering the previous 7 days [today-7, today-1]. Idempotent across restarts/reticks:
    /// the LastRecapSent guard is STAMPED (to today's local date) and persisted BEFORE the irreversible
    /// Discord send, so a confirmed-but-unrecorded send can never repeat if the preference row vanishes or
    /// its email changes between send and re-load. The trade-off is deliberate: a rare send failure after
    /// stamping simply skips that user's recap for the week rather than risking a duplicate.
    /// </summary>
    private static async Task SendWeeklyRecapsAsync(
        UsageDbContext db, WeeklyRecapComposer recap, DateTimeOffset nowLocal, CancellationToken ct)
    {
        if (nowLocal.DayOfWeek != DayOfWeek.Sunday || nowLocal.Hour < RecapHourLocal) return;

        var today = DateOnly.FromDateTime(nowLocal.DateTime);
        var from = today.AddDays(-7);
        var to = today.AddDays(-1);

        // Candidates: opted-in, webhook present, not already sent today (the recap-day local date is the
        // per-week anchor — at most one send per user per recap day). Project to emails only (no secrets).
        var candidates = await db.NotificationPreferences.AsNoTracking()
            .Where(p => p.WeeklyRecapEnabled && p.DiscordWebhookEnc != null && p.LastRecapSent != today)
            .Select(p => p.UserEmail)
            .ToListAsync(ct);

        foreach (var email in candidates)
        {
            // Stamp-first: claim this user's recap by advancing the guard and persisting it BEFORE the send.
            // Re-load the tracked row; if it vanished (deleted/re-provisioned) or was already stamped this
            // tick's date, skip — the send is only attempted once the guard is durably recorded.
            var pref = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserEmail == email, ct);
            if (pref is null || pref.LastRecapSent == today) continue;
            pref.LastRecapSent = today;
            await db.SaveChangesAsync(ct);

            // The composer re-checks opt-in + webhook + validity and decrypts in-memory at send time.
            // A send failure here forfeits this week's recap for the user rather than risking a duplicate.
            await recap.SendRecapAsync(email, from, to, today, ct);
        }
    }

    // The audit actions that represent a NEW USER arriving (open-signup auto-provision + admin-create).
    private static readonly HashSet<string> SignupActions =
        new(StringComparer.Ordinal) { "user.autoprovisioned", "user.created" };

    private static async Task ForwardSecurityAsync(
        UsageDbContext db, DiscordNotifier notifier, NotificationSetting s, string url,
        bool securityOn, bool signupOn, string? securityMention, string? signupMention, CancellationToken ct)
    {
        // The baseline (LastAuditAlertId) is set when a route is turned on, so history isn't replayed.
        var newEntries = await db.AuditEntries.AsNoTracking()
            .Where(a => a.Id > s.LastAuditAlertId).OrderBy(a => a.Id).Take(20).ToListAsync(ct);
        if (newEntries.Count == 0) return;

        var advanced = false;
        foreach (var e in newEntries)
        {
            var isSignup = SignupActions.Contains(e.Action);
            // This entry forwards if security-alerts is on (all entries), OR it's a signup and that route is on.
            if (securityOn || (signupOn && isSignup))
            {
                // Never let an auth.* event carry the @everyone/@here mention — those can be triggered by
                // outside parties; reserve pings for admin-initiated user.* management changes.
                var baseMention = (signupOn && isSignup && !securityOn) ? signupMention : securityMention;
                var mention = e.Action.StartsWith("auth.", StringComparison.Ordinal) ? null : baseMention;
                if (!await notifier.SendSecurityAsync(url, e.Action, e.ActorEmail, e.TargetEmail, e.Detail, mention, ct))
                    break; // stop on failure; retry from here next tick
            }
            // Advance the high-water mark even for entries this tick chose to skip (e.g. signup-only mode
            // skipping a non-signup entry) so a skipped entry isn't reconsidered forever.
            s.LastAuditAlertId = e.Id;
            advanced = true;
        }
        if (advanced) await db.SaveChangesAsync(ct);
    }

    private static async Task<TimeZoneInfo> ResolveTzAsync(UsageDbContext db, CancellationToken ct)
    {
        var tzId = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        if (string.IsNullOrWhiteSpace(tzId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tzId); }
        catch { return TimeZoneInfo.Utc; }
    }
}
