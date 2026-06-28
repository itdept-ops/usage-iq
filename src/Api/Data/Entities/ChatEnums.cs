namespace Ccusage.Api.Data.Entities;

/// <summary>Whether a chat conversation is a named channel or a 1:1 direct message.</summary>
public enum ChannelKind
{
    Channel = 0,
    Direct = 1,
}

/// <summary>The kind of in-app notification, used to gate delivery against per-user preferences.</summary>
public enum NotificationType
{
    DirectMessage = 0,
    Mention = 1,
    ChannelMessage = 2,
    SystemSyncFailed = 3,
    SystemUserJoined = 4,
    SystemFleetOffline = 5,

    /// <summary>A Family Hub reminder came due for its target member.</summary>
    FamilyReminder = 6,

    /// <summary>A Family Hub shared timer finished (pings the whole household).</summary>
    FamilyTimer = 7,

    /// <summary>The Family Hub daily morning briefing (pings every household member's bell).</summary>
    FamilyBriefing = 8,

    /// <summary>A Family Hub calendar event is starting soon (pings every household member's bell).</summary>
    FamilyHeadsUp = 9,

    /// <summary>One of the owner's own automation rules fired — a self-notification to themselves only.</summary>
    SystemAutomation = 10,

    /// <summary>Someone in the actor's circle cheered (👏) one of their activity-feed events (a peer action,
    /// not gated like a system event — the actor always learns their event was cheered).</summary>
    Cheer = 11,

    /// <summary>Someone in the target's circle (a contact or fellow household member) sent them a canned
    /// "nudge" (log your day / close your rings / keep the streak / check-in). A peer action like
    /// <see cref="Cheer"/> — circle-gated + cooldowned at the endpoint, carrying the sender as actor; the
    /// text is a FIXED server-side template keyed by the nudge kind (never client free-text).</summary>
    SystemNudge = 12,

    /// <summary>A per-user PROACTIVE SCHEDULED AGENT fired (morning briefing / streak rescue / budget alert /
    /// low staples). Self-scoped — it only ever pings its own owner's bell + opt-in web push. Gated, like a
    /// system event, on <see cref="NotificationPreference.NotifySystemEvents"/> at delivery (NotifySystem).</summary>
    AgentNudge = 13,
}

/// <summary>
/// The user-facing CATEGORIES a notification can fall into for PER-CATEGORY Discord forwarding. A
/// <see cref="FlagsAttribute"/> bitmask stored on <c>NotificationPreference.DiscordCategories</c>; each
/// <see cref="NotificationType"/> maps to exactly one category via <see cref="DiscordCategoryMap.For"/>.
/// This gates ONLY the Discord mirror — it is INDEPENDENT of the in-app trigger gates and never affects
/// whether the in-app notification is created. The master <c>SurfaceDiscord</c> toggle still wins (off ⇒
/// nothing forwards). <see cref="All"/> is the default so enabling Discord forwards everything (the
/// pre-existing behavior), keeping the schema add non-breaking.
/// </summary>
[Flags]
public enum DiscordForwardCategory
{
    None = 0,
    DirectMessages = 1 << 0,
    Mentions = 1 << 1,
    ChannelMessages = 1 << 2,
    SystemEvents = 1 << 3,
    FamilyAlerts = 1 << 4,
    Cheers = 1 << 5,
    Nudges = 1 << 6,

    /// <summary>Every category — the default mask (preserve "forward everything you receive").</summary>
    All = DirectMessages | Mentions | ChannelMessages | SystemEvents | FamilyAlerts | Cheers | Nudges,
}

/// <summary>Maps each <see cref="NotificationType"/> to the single <see cref="DiscordForwardCategory"/>
/// the user toggles for Discord forwarding, and tests a stored mask against a type.</summary>
public static class DiscordCategoryMap
{
    /// <summary>The category a given notification type forwards under (1:1, total over all 13 types).</summary>
    public static DiscordForwardCategory For(NotificationType type) => type switch
    {
        NotificationType.DirectMessage => DiscordForwardCategory.DirectMessages,
        NotificationType.Mention => DiscordForwardCategory.Mentions,
        NotificationType.ChannelMessage => DiscordForwardCategory.ChannelMessages,

        NotificationType.SystemSyncFailed => DiscordForwardCategory.SystemEvents,
        NotificationType.SystemUserJoined => DiscordForwardCategory.SystemEvents,
        NotificationType.SystemFleetOffline => DiscordForwardCategory.SystemEvents,
        NotificationType.SystemAutomation => DiscordForwardCategory.SystemEvents,

        NotificationType.FamilyReminder => DiscordForwardCategory.FamilyAlerts,
        NotificationType.FamilyTimer => DiscordForwardCategory.FamilyAlerts,
        NotificationType.FamilyBriefing => DiscordForwardCategory.FamilyAlerts,
        NotificationType.FamilyHeadsUp => DiscordForwardCategory.FamilyAlerts,

        NotificationType.Cheer => DiscordForwardCategory.Cheers,
        NotificationType.SystemNudge => DiscordForwardCategory.Nudges,

        // A scheduled agent is a self-scoped automation; forward it under the user-toggleable System bucket.
        NotificationType.AgentNudge => DiscordForwardCategory.SystemEvents,

        // Any future type defaults to SystemEvents (a safe, user-toggleable bucket) until mapped explicitly.
        _ => DiscordForwardCategory.SystemEvents,
    };

    /// <summary>True when the stored category mask permits forwarding the given notification type. A mask of 0
    /// is treated LITERALLY as <see cref="DiscordForwardCategory.None"/> — an EXPLICIT "forward nothing" — not
    /// as a legacy all-on fallback. The entity CLR-defaults the column to <see cref="DiscordForwardCategory.All"/>
    /// and the migration backfilled existing rows to <see cref="DiscordForwardCategory.All"/>, so the only way a
    /// row holds 0 is a user deliberately turning every category off (which then correctly suppresses the mirror).
    /// The master <c>SurfaceDiscord</c> toggle is gated upstream and still wins.</summary>
    public static bool Allows(int categoriesMask, NotificationType type)
        => (categoriesMask & (int)For(type)) != 0;
}
