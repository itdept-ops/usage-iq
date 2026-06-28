using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The proactive scheduled-agents background tick — a SIBLING of <see cref="NotificationBackgroundService"/>.
/// Roughly once a minute it scans the BOUNDED set of enabled <see cref="ScheduledAgent"/> rows that haven't
/// fired yet today-local and whose owner's local time has reached their <see cref="ScheduledAgent.DeliverHourLocal"/>,
/// and for each due one composes a per-kind nudge and delivers it to the owner's bell (+ opt-in web push) via
/// <see cref="ChatNotificationService"/>.
///
/// <para>INVARIANTS honoured here (the review checks these):</para>
/// <list type="bullet">
///   <item>IDEMPOTENCY STAMP-FIRST — the agent's <see cref="ScheduledAgent.LastFiredLocalDate"/> /
///   <see cref="ScheduledAgent.LastFiredKey"/> are written BEFORE notifying, so a crash after the stamp never
///   double-nudges (mirrors <see cref="FamilyBriefingService"/> + the reminder tick).</item>
///   <item>BOUNDED PER-TICK QUERY — the candidate read is filtered (Enabled, not-fired-this-local-date) and
///   PAGED (<see cref="MaxAgentsPerTick"/>); it never loads every user every minute.</item>
///   <item>AI-FLOOR — every kind has a guaranteed deterministic composed line; the AI narrative is an upgrade
///   that only runs when the user holds the relevant EXISTING AI key (family.ai / finance.ai), degrades
///   silently to the floor on any error, and is the only token spend.</item>
///   <item>QUIET HOURS — honoured per agent, correct across midnight (drop-for-the-day for briefing/budget,
///   defer for streak rescue).</item>
///   <item>PER-USER TIMEZONE — all deliver-hour / quiet-hour / local-date math is done in the agent's own
///   <see cref="ScheduledAgent.TimeZone"/>, resolved + cached per tick.</item>
///   <item>DIETARY EXCLUSION — the LowStaples nudge never names a staple that matches the household's
///   union of standing allergies/avoids.</item>
/// </list>
///
/// The tick body is a public instance method (<see cref="TickAsync"/>) taking the clock so tests can drive a
/// single deterministic cycle.
/// </summary>
public sealed class AgentScheduler(
    IServiceScopeFactory scopeFactory, ILogger<AgentScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    /// <summary>Hard upper bound on agents handled per tick — keeps the per-minute scan bounded regardless of
    /// how many become due at once (the rest are picked up on the next tick).</summary>
    public const int MaxAgentsPerTick = 200;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                var sp = scope.ServiceProvider;
                await TickAsync(
                    sp.GetRequiredService<UsageDbContext>(),
                    sp.GetRequiredService<ChatNotificationService>(),
                    sp.GetRequiredService<AgentComposer>(),
                    DateTime.UtcNow, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogError(ex, "Agent scheduler tick failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>
    /// One deterministic tick as of <paramref name="nowUtc"/>: deliver every DUE scheduled agent (enabled,
    /// owner-local time past its deliver hour, not already fired this local date, not in a quiet window).
    /// Public + parameterized so tests can drive a single cycle with a fixed clock and the resolved services.
    /// Returns the number of agents that actually delivered a nudge this tick.
    /// </summary>
    public async Task<int> TickAsync(
        UsageDbContext db, ChatNotificationService notifier, AgentComposer composer,
        DateTime nowUtc, CancellationToken ct = default)
    {
        var utc = DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc);

        // BOUNDED candidate read: only enabled agents that have NOT already fired today (anchored on the local
        // date) are even worth considering. We can't compute "today-local" in SQL across mixed timezones, so we
        // bound the set with a coarse, timezone-agnostic SUPERSET filter — keep any agent that COULD still be due
        // in some zone — then re-check precisely in memory. The floor must be utcDate+2: a due-but-unfired agent's
        // LastFiredLocalDate is at most yesterday-local, which for UTC+14 can be as recent as utcDate; and an
        // already-fired-today agent in UTC+14 stamps utcDate+1. Keeping rows with LastFiredLocalDate < utcDate+2
        // covers both (offsets up to UTC+14 / down to UTC-12); the precise in-memory check drops the truly-fired
        // ones. (A tighter floor like utcDate-1 silently EXCLUDES due agents east of UTC.) Still filtered + paged.
        var coarseFloor = DateOnly.FromDateTime(utc).AddDays(2);
        var candidates = await db.ScheduledAgents
            .Where(a => a.Enabled && (a.LastFiredLocalDate == null || a.LastFiredLocalDate < coarseFloor))
            .OrderBy(a => a.Id)
            .Take(MaxAgentsPerTick)
            .ToListAsync(ct);
        if (candidates.Count == 0) return 0;

        // Resolve each distinct IANA id to a TimeZoneInfo ONCE per tick.
        var tzCache = new Dictionary<string, TimeZoneInfo>(StringComparer.Ordinal);
        TimeZoneInfo ResolveTz(string? id)
        {
            var key = string.IsNullOrWhiteSpace(id) ? "UTC" : id!;
            if (tzCache.TryGetValue(key, out var hit)) return hit;
            var tz = ResolveTimeZone(key);
            tzCache[key] = tz;
            return tz;
        }

        var delivered = 0;
        foreach (var agent in candidates)
        {
            try
            {
                var tz = ResolveTz(agent.TimeZone);
                var localNow = TimeZoneInfo.ConvertTimeFromUtc(utc, tz);
                var localDate = DateOnly.FromDateTime(localNow);

                // Precise idempotency: already fired for THIS local date? (the coarse SQL floor lets the prior
                // local date through near midnight in some zones — re-check exactly here.)
                if (agent.LastFiredLocalDate == localDate) continue;

                // Too early in the local day.
                if (localNow.Hour < agent.DeliverHourLocal) continue;

                // Quiet hours. MorningBriefing + BudgetAlert DROP for the day if currently quiet (a stale morning
                // briefing at 11pm is noise); StreakRescue DEFERS (it wants a later tick, outside quiet hours,
                // before the day ends) so we simply skip without stamping.
                if (InQuietHours(localNow.Hour, agent.QuietStartLocalHour, agent.QuietEndLocalHour))
                {
                    if (agent.Kind is ScheduledAgentKind.StreakRescue) continue; // defer; try again next tick
                    // else fall through to STAMP-and-skip below (drop-for-the-day) so we don't reconsider it.
                    await StampFiredAsync(db, agent, localDate, FireKey(agent.Kind, localDate), ct);
                    continue;
                }

                // Compose the nudge (deterministic floor + optional AI upgrade gated on the existing AI key).
                var nudge = await composer.ComposeAsync(db, agent, utc, ct);

                // STAMP FIRST (idempotency): a crash after this never re-nudges this occurrence.
                await StampFiredAsync(db, agent, localDate, FireKey(agent.Kind, localDate), ct);

                // A composer may return null when there is genuinely nothing to say (e.g. no incomplete streak
                // tasks, staples fully stocked) — we still stamped (don't reconsider today), but send nothing.
                if (nudge is null) continue;

                await notifier.NotifySystem(
                    new[] { agent.UserEmail }, NotificationType.AgentNudge, nudge.Text, nudge.Link, ct);
                delivered++;
            }
            catch (Exception ex)
            {
                // Swallow per-agent so one bad agent can't block the rest; ExecuteAsync logs tick-level failures.
                logger.LogWarning("Scheduled agent {Kind} for a user failed: {Reason}", agent.Kind, ex.Message);
            }
        }
        return delivered;
    }

    /// <summary>The per-occurrence de-dupe key stamped alongside the local-date anchor (e.g. "streak:2026-06-27").</summary>
    public static string FireKey(ScheduledAgentKind kind, DateOnly localDate) =>
        $"{kind.ToString().ToLowerInvariant()}:{localDate:yyyy-MM-dd}";

    /// <summary>
    /// Persist the idempotency stamp for <paramref name="agent"/> in its OWN write (so it lands before any
    /// notify) via a targeted ExecuteUpdate — mirrors the family briefing's stamp-first ExecuteUpdate.
    /// </summary>
    private static async Task StampFiredAsync(
        UsageDbContext db, ScheduledAgent agent, DateOnly localDate, string key, CancellationToken ct)
    {
        agent.LastFiredLocalDate = localDate;
        agent.LastFiredKey = key;
        await db.ScheduledAgents.Where(a => a.Id == agent.Id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(a => a.LastFiredLocalDate, localDate)
                .SetProperty(a => a.LastFiredKey, key), ct);
    }

    /// <summary>
    /// Whether <paramref name="hour"/> (0–23 local) falls inside the quiet window [start, end) — inclusive
    /// start, exclusive end — handling a window that WRAPS past midnight (start &gt; end, e.g. 22→7 means
    /// 22,23,0..6 are quiet). Both null (or equal) ⇒ no quiet window ⇒ never quiet.
    /// </summary>
    public static bool InQuietHours(int hour, int? start, int? end)
    {
        if (start is not int s || end is not int e) return false;
        s = ((s % 24) + 24) % 24;
        e = ((e % 24) + 24) % 24;
        if (s == e) return false; // empty window
        return s < e
            ? hour >= s && hour < e          // same-day window, e.g. 1..5
            : hour >= s || hour < e;         // wraps midnight, e.g. 22..7
    }

    /// <summary>Resolve an IANA id to a <see cref="TimeZoneInfo"/>, falling back to UTC on anything odd.</summary>
    public static TimeZoneInfo ResolveTimeZone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }
}
