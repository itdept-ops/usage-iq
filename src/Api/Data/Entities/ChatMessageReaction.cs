namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One emoji reaction on a <see cref="ChatMessage"/> by one user. At most one of a given emoji per
/// user per message (enforced by a unique index on (MessageId, UserEmail, Emoji)); a second toggle of
/// the same emoji removes the row. Cascade-deleted with its parent message.
/// </summary>
public class ChatMessageReaction
{
    public long Id { get; set; }

    public long MessageId { get; set; }
    public ChatMessage? Message { get; set; }

    /// <summary>Reactor email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The emoji (a short grapheme/string), trimmed; max length 32.</summary>
    public string Emoji { get; set; } = "";

    public DateTime CreatedUtc { get; set; }
}
