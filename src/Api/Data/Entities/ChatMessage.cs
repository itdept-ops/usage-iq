namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A single message in a <see cref="ChatChannel"/>. Edits stamp <see cref="EditedUtc"/>; deletes are
/// soft (set <see cref="DeletedUtc"/>) and the body must never be leaked for a deleted message.
/// </summary>
public class ChatMessage
{
    public long Id { get; set; }

    public int ChannelId { get; set; }
    public ChatChannel? Channel { get; set; }

    /// <summary>Sender email, stored lower-cased.</summary>
    public string SenderEmail { get; set; } = "";

    public string Body { get; set; } = "";

    public DateTime CreatedUtc { get; set; }

    public DateTime? EditedUtc { get; set; }

    /// <summary>When set, the message is soft-deleted; its body must not be exposed.</summary>
    public DateTime? DeletedUtc { get; set; }
}
