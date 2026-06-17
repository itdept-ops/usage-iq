namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One in-app inbox notification for a single recipient. Created by the chat fan-out (direct
/// messages, mentions, channel posts) and by system events. The <see cref="Type"/> is gated against
/// the recipient's <see cref="NotificationPreference"/> before a row is written.
/// </summary>
public class Notification
{
    public long Id { get; set; }

    /// <summary>Recipient email, stored lower-cased.</summary>
    public string RecipientEmail { get; set; } = "";

    public NotificationType Type { get; set; }

    public string Text { get; set; } = "";

    /// <summary>Optional deep-link, e.g. "/chat?c={channelId}&amp;m={messageId}".</summary>
    public string? Link { get; set; }

    /// <summary>Email of the actor that triggered this notification (sender), if any. Lower-cased.</summary>
    public string? ActorEmail { get; set; }

    /// <summary>Display name of the actor at the time of the event, if any.</summary>
    public string? ActorName { get; set; }

    public bool IsRead { get; set; }

    public DateTime CreatedUtc { get; set; }
}
