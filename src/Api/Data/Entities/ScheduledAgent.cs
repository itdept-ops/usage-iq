namespace Ccusage.Api.Data.Entities;

/// <summary>
/// The KIND of proactive scheduled agent. Stored by int so future kinds append without renumbering.
/// <list type="bullet">
///   <item><see cref="MorningBriefing"/> — a per-USER wrapper of the household morning briefing.</item>
///   <item><see cref="StreakRescue"/> — a late-day nudge when today's 75-Hard / hydration tasks are incomplete.</item>
///   <item><see cref="BudgetAlert"/> — a heads-up on the month's household spend pace.</item>
///   <item><see cref="LowStaples"/> — a nudge when shopping-list staples are running low.</item>
///   <item><see cref="MedicationDue"/> — an OWNER-ONLY reminder when a reminders-enabled medication's due
///   dose for today is still unlogged at/after the deliver hour. Private health data; self-scoped only.</item>
/// </list>
/// </summary>
public enum ScheduledAgentKind
{
    MorningBriefing = 0,
    StreakRescue = 1,
    BudgetAlert = 2,
    LowStaples = 3,
    MedicationDue = 4,
}

/// <summary>
/// One user's per-kind preference + idempotency state for a proactive scheduled agent. There is at most ONE
/// row per (<see cref="UserEmail"/>, <see cref="Kind"/>) — a unique index enforces it, and the GET endpoint
/// upserts a disabled default row per kind on first read (mirrors <see cref="NotificationPreference"/>).
///
/// <para>The agent only fires when <see cref="Enabled"/> and the user's LOCAL time (in <see cref="TimeZone"/>)
/// has reached <see cref="DeliverHourLocal"/> and it hasn't already fired for the current local date. The
/// scheduler STAMPS <see cref="LastFiredLocalDate"/>/<see cref="LastFiredKey"/> BEFORE notifying, so a crash
/// after the stamp never double-nudges (mirrors the family briefing + reminder idempotency).</para>
///
/// <para>Quiet hours (<see cref="QuietStartLocalHour"/>..<see cref="QuietEndLocalHour"/>, each 0–23, inclusive
/// start / exclusive end, may wrap past midnight) suppress delivery during the window; both null = no quiet
/// window. Self-scoped only — an agent only ever reads/acts on its own user's data; the email is the scope key.</para>
/// </summary>
public class ScheduledAgent
{
    public int Id { get; set; }

    /// <summary>Owner email, stored lower-cased; the scope + identity key (unique with <see cref="Kind"/>).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>Which proactive agent this row configures.</summary>
    public ScheduledAgentKind Kind { get; set; }

    /// <summary>Whether the agent runs. Default OFF — every agent is opt-in per kind.</summary>
    public bool Enabled { get; set; }

    /// <summary>Local hour-of-day (0–23) at/after which the agent fires for the day.</summary>
    public int DeliverHourLocal { get; set; }

    /// <summary>Inclusive local hour (0–23) the quiet window opens, or null for no quiet window.</summary>
    public int? QuietStartLocalHour { get; set; }

    /// <summary>Exclusive local hour (0–23) the quiet window closes, or null for no quiet window.</summary>
    public int? QuietEndLocalHour { get; set; }

    /// <summary>IANA timezone id (e.g. "America/New_York") the deliver-hour / quiet-hours math is done in.</summary>
    public string TimeZone { get; set; } = "America/New_York";

    /// <summary>
    /// Idempotency anchor: the local date the agent last fired. The scheduler will not fire again for the same
    /// local date. Stamped BEFORE notifying. Null = never fired.
    /// </summary>
    public DateOnly? LastFiredLocalDate { get; set; }

    /// <summary>
    /// Per-occurrence de-dupe key (e.g. "streak:2026-06-27"), recorded alongside the anchor so a future
    /// finer-grained occurrence (more than one per local day) can't double-fire. Null = never fired.
    /// </summary>
    public string? LastFiredKey { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
