using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The Family Hub F2 background tick. Roughly every 30 seconds it:
/// <list type="number">
///   <item>Fires <see cref="FamilyReminder"/>s that are <see cref="FamilyReminder.Active"/> and whose
///   <see cref="FamilyReminder.DueUtc"/> is in the past — pinging the target member via the existing
///   in-app notification path (bell + toast + unread), then advancing a recurring reminder's DueUtc to
///   the next occurrence (or deactivating a one-shot). <see cref="FamilyReminder.LastFiredUtc"/> is
///   stamped, and the work is idempotent on a tick (a recurring reminder advances PAST <c>now</c>, a
///   one-shot deactivates, so re-running the same tick fires nothing twice).</item>
///   <item>Completes <see cref="FamilyTimer"/>s whose <see cref="FamilyTimer.EndsUtc"/> is in the past
///   and that aren't <see cref="FamilyTimer.Done"/> yet — marking them Done and pinging every household
///   member ("⏰ {Label} is up!").</item>
/// </list>
/// All times are UTC. Background work follows the existing IHostedService pattern and resolves the
/// scoped <see cref="UsageDbContext"/> + <see cref="ChatNotificationService"/> per tick via
/// <see cref="IServiceScopeFactory"/>. The tick body is a public instance method so tests can invoke a
/// single deterministic cycle directly.
/// </summary>
public sealed class FamilyReminderService(
    IServiceScopeFactory scopeFactory, ILogger<FamilyReminderService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
                var notifier = scope.ServiceProvider.GetRequiredService<ChatNotificationService>();
                var briefing = scope.ServiceProvider.GetRequiredService<FamilyBriefingService>();
                await TickAsync(db, notifier, DateTime.UtcNow, stoppingToken, briefing);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogError(ex, "Family reminder/timer tick failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>
    /// One deterministic tick: fire due reminders, complete finished timers, and deliver any due daily
    /// briefings as of <paramref name="now"/>. Public + parameterized so tests can drive a single cycle with
    /// a fixed clock and the resolved services. The <paramref name="briefing"/> service is optional so the
    /// existing reminder/timer tests can call this without it (briefings then simply don't run). Returns a
    /// small summary of what fired (handy for assertions).
    /// </summary>
    public async Task<TickResult> TickAsync(
        UsageDbContext db, ChatNotificationService notifier, DateTime now, CancellationToken ct = default,
        FamilyBriefingService? briefing = null)
    {
        var reminders = await FireDueRemindersAsync(db, notifier, now, ct);
        var timers = await CompleteFinishedTimersAsync(db, notifier, now, ct);
        var briefings = briefing is null ? 0 : await DeliverDueBriefingsAsync(db, briefing, now, ct);
        var choreResets = await ResetRecurringChoresAsync(db, now, ct);
        return new TickResult(reminders, timers, briefings, choreResets);
    }

    /// <summary>The count of reminders fired, timers completed, briefings delivered, and recurring chores
    /// reset for the new period in a tick.</summary>
    public readonly record struct TickResult(
        int RemindersFired, int TimersCompleted, int BriefingsDelivered, int ChoresReset);

    // ---- Daily briefing ----

    /// <summary>
    /// Deliver the daily morning briefing for every household whose local time has reached its briefing hour
    /// and that hasn't been briefed yet today-local. The per-household guard
    /// (<see cref="Household.LastBriefingLocalDate"/>) makes this idempotent within a local day. Each
    /// household is independent — one failing must not stop the rest.
    /// </summary>
    private static async Task<int> DeliverDueBriefingsAsync(
        UsageDbContext db, FamilyBriefingService briefing, DateTime now, CancellationToken ct)
    {
        var households = await db.Households.AsNoTracking()
            .Where(h => h.BriefingEnabled)
            .ToListAsync(ct);
        if (households.Count == 0) return 0;

        var delivered = 0;
        foreach (var h in households)
        {
            try
            {
                if (await briefing.RunIfDueAsync(h, now, ct)) delivered++;
            }
            catch (Exception)
            {
                // Swallow per-household so one bad household can't block the others; the background
                // ExecuteAsync wrapper logs unexpected tick failures.
            }
        }
        return delivered;
    }

    // ---- Recurring chore reset (F4) ----

    /// <summary>
    /// Reset every Done, recurring (<c>daily</c>/<c>weekly</c>) <see cref="FamilyChore"/> whose
    /// <see cref="FamilyChore.DoneUtc"/> falls BEFORE the current period start — so it reappears as not-done
    /// for the new day/week. The period start is computed in the owning household's
    /// <see cref="Household.TimeZone"/> (today-local for daily, the local week start (Monday) for weekly),
    /// then converted to UTC for the comparison. The completion ledger (and thus the points tally) is left
    /// intact — only the chore's Done/DoneBy/DoneUtc stamps are cleared. Idempotent: a chore done within the
    /// current period is untouched, and once reset its DoneUtc is null so it won't reset again.
    /// </summary>
    private static async Task<int> ResetRecurringChoresAsync(UsageDbContext db, DateTime now, CancellationToken ct)
    {
        var candidates = await db.FamilyChores
            .Where(c => c.Done && c.Recurrence != "none" && c.DoneUtc != null)
            .ToListAsync(ct);
        if (candidates.Count == 0) return 0;

        // Each chore's period start depends on its household timezone — resolve timezones once per household.
        var householdIds = candidates.Select(c => c.HouseholdId).Distinct().ToList();
        var zones = await db.Households.AsNoTracking()
            .Where(h => householdIds.Contains(h.Id))
            .Select(h => new { h.Id, h.TimeZone })
            .ToDictionaryAsync(h => h.Id, h => h.TimeZone, ct);

        var reset = 0;
        foreach (var chore in candidates)
        {
            var tzId = zones.GetValueOrDefault(chore.HouseholdId);
            var tz = ResolveChoreTimeZone(tzId);
            var periodStartUtc = PeriodStartUtc(chore.Recurrence, now, tz);
            if (chore.DoneUtc!.Value < periodStartUtc)
            {
                chore.Done = false;
                chore.DoneByUserId = null;
                chore.DoneUtc = null;
                reset++;
            }
        }
        if (reset > 0) await db.SaveChangesAsync(ct);
        return reset;
    }

    /// <summary>
    /// The UTC instant the current chore period began as of <paramref name="now"/>, in zone
    /// <paramref name="tz"/>: local midnight today for "daily", local midnight of this week's Monday for
    /// "weekly". A done chore stamped before this counts as last period's and is reset.
    /// </summary>
    private static DateTime PeriodStartUtc(string recurrence, DateTime now, TimeZoneInfo tz)
    {
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(now, DateTimeKind.Utc), tz);
        var localDate = localNow.Date;
        if (string.Equals(recurrence, "weekly", StringComparison.OrdinalIgnoreCase))
        {
            // ISO week start = Monday. DayOfWeek Sunday=0..Saturday=6 → map to Mon=0..Sun=6.
            var offset = ((int)localDate.DayOfWeek + 6) % 7;
            localDate = localDate.AddDays(-offset);
        }
        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(localDate, DateTimeKind.Unspecified), tz);
    }

    /// <summary>Resolve an IANA id to a <see cref="TimeZoneInfo"/>, falling back to UTC on anything odd.</summary>
    private static TimeZoneInfo ResolveChoreTimeZone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }

    // ---- Reminders ----

    private static async Task<int> FireDueRemindersAsync(
        UsageDbContext db, ChatNotificationService notifier, DateTime now, CancellationToken ct)
    {
        // Snapshot the due, still-active reminders for this cycle. Re-reading inside the loop isn't needed:
        // each reminder is mutated (advanced past now OR deactivated) before the next, so a row can't be
        // selected twice within one tick.
        var due = await db.FamilyReminders
            .Where(r => r.Active && r.DueUtc <= now)
            .OrderBy(r => r.DueUtc)
            .ToListAsync(ct);
        if (due.Count == 0) return 0;

        var fired = 0;
        foreach (var r in due)
        {
            // Persist the state advance FIRST (so a crash/retry never re-pings the same occurrence), then notify.
            r.LastFiredUtc = now;
            if (string.Equals(r.Recurrence, "none", StringComparison.OrdinalIgnoreCase))
            {
                r.Active = false; // one-shot: done after this fire
            }
            else
            {
                // Advance to the NEXT occurrence strictly after now (covers a tick that slept through
                // several periods, e.g. after a restart) and stay active.
                r.DueUtc = NextOccurrence(r.DueUtc, r.Recurrence, now);
            }
            await db.SaveChangesAsync(ct);

            await notifier.NotifyFamily(
                new[] { r.TargetUserId },
                NotificationType.FamilyReminder,
                $"⏰ Reminder: {r.Text}",
                "/family/reminders",
                ct);
            fired++;
        }
        return fired;
    }

    /// <summary>
    /// The next firing time for a recurring reminder strictly after <paramref name="now"/>, starting from
    /// its current <paramref name="from"/> due time. "daily" = +1 day, "weekly" = +7 days, "weekdays" =
    /// the next Mon–Fri (skipping Sat/Sun). Always lands strictly in the future so a long-overdue reminder
    /// fires once then schedules ahead rather than re-firing every tick. An unknown recurrence is treated
    /// as daily (defensive; the API validates the value on write).
    /// </summary>
    public static DateTime NextOccurrence(DateTime from, string recurrence, DateTime now)
    {
        DateTime Step(DateTime t) => recurrence.ToLowerInvariant() switch
        {
            "weekly" => t.AddDays(7),
            "weekdays" => NextWeekday(t),
            _ => t.AddDays(1), // "daily" and any unknown value
        };

        var next = Step(from);
        // Skip any periods already in the past (e.g. the service was down for days).
        while (next <= now) next = Step(next);
        return next;
    }

    /// <summary>The next calendar day that is a weekday (Mon–Fri), preserving the time of day.</summary>
    private static DateTime NextWeekday(DateTime t)
    {
        var d = t.AddDays(1);
        while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) d = d.AddDays(1);
        return d;
    }

    // ---- Timers ----

    private static async Task<int> CompleteFinishedTimersAsync(
        UsageDbContext db, ChatNotificationService notifier, DateTime now, CancellationToken ct)
    {
        var finished = await db.FamilyTimers
            .Where(t => !t.Done && t.EndsUtc <= now)
            .OrderBy(t => t.EndsUtc)
            .ToListAsync(ct);
        if (finished.Count == 0) return 0;

        var completed = 0;
        foreach (var t in finished)
        {
            // Mark done FIRST so a retry never re-notifies, then ping the whole household.
            t.Done = true;
            await db.SaveChangesAsync(ct);

            var memberIds = await db.HouseholdMembers.AsNoTracking()
                .Where(m => m.HouseholdId == t.HouseholdId)
                .Select(m => m.UserId)
                .ToListAsync(ct);

            await notifier.NotifyFamily(
                memberIds,
                NotificationType.FamilyTimer,
                $"⏰ {t.Label} is up!",
                "/family/timers",
                ct);
            completed++;
        }
        return completed;
    }
}
