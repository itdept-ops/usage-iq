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
}
