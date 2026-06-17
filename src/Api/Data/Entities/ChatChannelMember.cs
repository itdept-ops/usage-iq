namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One member's participation in a <see cref="ChatChannel"/>. Carries the per-user read cursor
/// (<see cref="LastReadMessageId"/>) used to compute unread counts, and an optional mute window.
/// Unique per (channel, user).
/// </summary>
public class ChatChannelMember
{
    public int Id { get; set; }

    public int ChannelId { get; set; }
    public ChatChannel? Channel { get; set; }

    /// <summary>Member email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    public DateTime JoinedUtc { get; set; }

    /// <summary>Id of the newest message this member has read; null = nothing read yet.</summary>
    public long? LastReadMessageId { get; set; }

    /// <summary>When set and in the future, notifications for this channel are suppressed.</summary>
    public DateTime? MutedUntil { get; set; }
}
