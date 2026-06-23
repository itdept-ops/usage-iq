namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One routable system Discord event (the daily/weekly digest, the spend-threshold alert, the
/// per-audit security alert, the new-user-signup notice). Replaces the boolean flags that used to live
/// on <see cref="NotificationSetting"/> with a per-event row the admin can enable/disable and give a
/// per-route mention. The webhook + global enable + digest schedule + threshold value still live on the
/// singleton <see cref="NotificationSetting"/>; these rows only gate WHICH events forward and HOW they ping.
/// </summary>
public class DiscordRoute
{
    public int Id { get; set; }

    /// <summary>Stable machine key for the event, unique (e.g. "daily-digest", "security-alerts").</summary>
    public string EventKey { get; set; } = "";

    /// <summary>Human label shown in the admin routing table.</summary>
    public string Label { get; set; } = "";

    /// <summary>Whether this event forwards to Discord at all.</summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Optional per-route mention prepended to the post (e.g. "@here" or "&lt;@&amp;roleId&gt;"), ≤64 chars.
    /// Null = no ping. Honored EXCEPT for auth.* security events (anti-abuse: an outside party can trigger
    /// those, so they never carry a mention regardless of this value).
    /// </summary>
    public string? Mention { get; set; }

    /// <summary>Display order in the admin table.</summary>
    public int SortOrder { get; set; }
}

/// <summary>The canonical set of routable system event keys (the seed + the lookup the senders use).</summary>
public static class DiscordRouteKeys
{
    public const string DailyDigest = "daily-digest";
    public const string WeeklyDigest = "weekly-digest";
    public const string SpendThreshold = "spend-threshold";
    public const string SecurityAlerts = "security-alerts";
    public const string NewUserSignup = "new-user-signup";
}
