namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A chat conversation. A named <see cref="ChannelKind.Channel"/> has a <see cref="Name"/> and any
/// number of members; a <see cref="ChannelKind.Direct"/> message has a null name and exactly two
/// members and is uniquely identified by the unordered pair of member emails.
/// </summary>
public class ChatChannel
{
    public int Id { get; set; }

    public ChannelKind Kind { get; set; }

    /// <summary>Display name for a channel; null for a direct message.</summary>
    public string? Name { get; set; }

    /// <summary>
    /// Stable identity of a <see cref="ChannelKind.Direct"/> conversation: the two member emails,
    /// lower-cased, ordinal-sorted and joined as <c>smaller|larger</c>. Null for named channels.
    /// A partial unique index over this column enforces one DM per unordered pair at the DB level.
    /// </summary>
    public string? DirectKey { get; set; }

    public string? Topic { get; set; }

    public bool IsPrivate { get; set; }

    /// <summary>Email of the creator, stored lower-cased.</summary>
    public string CreatedByEmail { get; set; } = "";

    public DateTime CreatedUtc { get; set; }

    /// <summary>When set, the channel is archived (soft-deleted) and hidden from active lists.</summary>
    public DateTime? ArchivedUtc { get; set; }

    public List<ChatChannelMember> Members { get; set; } = new();
    public List<ChatMessage> Messages { get; set; } = new();
}
