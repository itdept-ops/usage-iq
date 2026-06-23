namespace Ccusage.Api.Data.Entities;

/// <summary>
/// The FIXED, server-defined set of safe nudge templates. A nudge carries ONLY a kind — never any
/// client free-text — so the notification body is always a server-side template keyed by this enum.
/// This is what kills injection / @-mention abuse: the client can never put text into a notification.
/// An unknown/out-of-range kind is rejected with 400 at the endpoint.
/// </summary>
public enum NudgeKind
{
    /// <summary>"log your day" — a gentle prompt to record today's tracker entries.</summary>
    LogYourDay = 0,

    /// <summary>"close your rings" — the activity/move prompt.</summary>
    CloseYourRings = 1,

    /// <summary>"keep the streak" — a 75-Hard / streak-preservation prompt.</summary>
    KeepTheStreak = 2,

    /// <summary>"check-in" — a neutral "thinking of you / how's it going" ping.</summary>
    CheckIn = 3,
}

/// <summary>
/// One sent nudge: the audit row that also backs the per-(sender, target) COOLDOWN. Before sending,
/// the endpoint rejects (friendly no-op) if any row exists for the same (sender, target) inside the
/// cooldown window; on a successful nudge it inserts exactly one row. Emails are stored lower-cased and
/// are server-side only — they are NEVER serialized to the client (email-privacy).
/// </summary>
public class NudgeEvent
{
    public long Id { get; set; }

    /// <summary>The nudging user's email, lower-cased.</summary>
    public string SenderEmail { get; set; } = "";

    /// <summary>The nudged user's email, lower-cased.</summary>
    public string TargetEmail { get; set; } = "";

    /// <summary>Which canned template was sent.</summary>
    public NudgeKind Kind { get; set; }

    public DateTime CreatedUtc { get; set; }
}
