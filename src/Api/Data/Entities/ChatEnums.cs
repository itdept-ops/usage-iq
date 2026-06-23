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
}
