using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The single code path that turns a persisted <see cref="ChatMessage"/> into a real-time broadcast
/// plus per-recipient inbox notifications. Both the REST <c>POST /api/chat/channels/{id}/messages</c>
/// endpoint and the SignalR hub call <see cref="FanOutMessageAsync"/> so delivery behaves identically
/// regardless of transport.
///
/// Scoped: it depends on the (scoped) <see cref="UsageDbContext"/>. The singleton hub resolves it via a
/// per-invocation scope (see <see cref="Hubs.ChatHub"/>).
/// </summary>
public sealed class ChatNotificationService(UsageDbContext db, IHubContext<ChatHub> hub)
{
    /// <summary>Group name a connection joins for every channel it belongs to.</summary>
    public static string GroupFor(int channelId) => $"channel:{channelId}";

    /// <summary>
    /// Broadcast a freshly persisted message to the channel group and fan notifications out to every
    /// OTHER member (gated by their preferences + mute window). At most one notification row per
    /// (recipient, message). <paramref name="mentionedEmails"/> is validated against channel membership.
    /// </summary>
    public async Task FanOutMessageAsync(
        ChatChannel channel, ChatMessage message, string senderName, string? senderPicture,
        IReadOnlyCollection<string> mentionedEmails, CancellationToken ct = default)
    {
        var dto = ToDto(message, senderName, senderPicture);

        // Real-time: everyone in the channel (including the sender's other connections) sees it.
        await hub.Clients.Group(GroupFor(channel.Id)).SendAsync("ReceiveMessage", dto, ct);

        // Members other than the sender, with their per-channel read cursor + mute window.
        var members = await db.ChatChannelMembers.AsNoTracking()
            .Where(m => m.ChannelId == channel.Id && m.UserEmail != message.SenderEmail)
            .ToListAsync(ct);
        if (members.Count == 0) return;

        var memberEmails = members.Select(m => m.UserEmail).ToHashSet(StringComparer.Ordinal);

        // Only mentions of actual channel members count — never notify outsiders.
        var validMentions = (mentionedEmails ?? Array.Empty<string>())
            .Select(e => e.Trim().ToLowerInvariant())
            .Where(e => e.Length > 0 && memberEmails.Contains(e))
            .ToHashSet(StringComparer.Ordinal);

        // Preferences for the affected recipients (defaults where no row exists).
        var prefs = await db.NotificationPreferences.AsNoTracking()
            .Where(p => memberEmails.Contains(p.UserEmail))
            .ToDictionaryAsync(p => p.UserEmail, StringComparer.Ordinal, ct);

        var now = DateTime.UtcNow;
        var preview = Preview(message.Body);
        var text = $"{senderName}: {preview}";
        if (text.Length > 512) text = text[..512]; // guard against a future sender-name cap increase
        var link = $"/chat?c={channel.Id}&m={message.Id}";

        var created = new List<(string email, Notification row)>();
        foreach (var member in members)
        {
            if (member.MutedUntil is { } muted && muted > now) continue;

            var pref = prefs.GetValueOrDefault(member.UserEmail) ?? Defaults(member.UserEmail);

            NotificationType? type = null;
            if (validMentions.Contains(member.UserEmail) && pref.NotifyMentions)
                type = NotificationType.Mention;
            else if (channel.Kind == ChannelKind.Direct && pref.NotifyDirectMessages)
                type = NotificationType.DirectMessage;
            else if (pref.NotifyChannelMessages)
                type = NotificationType.ChannelMessage;

            if (type is null) continue;

            var n = new Notification
            {
                RecipientEmail = member.UserEmail,
                Type = type.Value,
                Text = text,
                Link = link,
                ActorEmail = message.SenderEmail,
                ActorName = senderName,
                IsRead = false,
                CreatedUtc = now,
            };
            db.Notifications.Add(n);
            created.Add((member.UserEmail, n));
        }

        if (created.Count > 0) await db.SaveChangesAsync(ct);

        // Every other member's per-channel unread MESSAGE badge changes when a new message lands —
        // UnreadChanged(channelId, perChannelMessageCount) always means exactly that.
        foreach (var member in members)
        {
            var unreadMessages = await db.ChatMessages.AsNoTracking()
                .CountAsync(m => m.ChannelId == channel.Id && m.DeletedUtc == null
                                 && m.SenderEmail != member.UserEmail
                                 && m.Id > (member.LastReadMessageId ?? 0), ct);
            await hub.Clients.User(member.UserEmail)
                .SendAsync("UnreadChanged", channel.Id, unreadMessages, ct);
        }

        // Recipients who actually got an inbox notification row also get their global inbox total.
        foreach (var (email, n) in created)
        {
            await hub.Clients.User(email).SendAsync("ReceiveNotification", ToDto(n), ct);
            var inboxUnread = await db.Notifications.CountAsync(x => x.RecipientEmail == email && !x.IsRead, ct);
            await hub.Clients.User(email).SendAsync("InboxUnreadChanged", inboxUnread, ct);
        }
    }

    /// <summary>
    /// Fan a system event out to the given recipients, gated only by each recipient's
    /// <see cref="NotificationPreference.NotifySystemEvents"/>. Persists one row per recipient and pushes
    /// <c>ReceiveNotification</c> to each. Wiring real system triggers is a later concern.
    /// </summary>
    public async Task NotifySystem(
        IEnumerable<string> recipientEmails, NotificationType type, string text, string? link,
        CancellationToken ct = default)
    {
        var emails = (recipientEmails ?? Enumerable.Empty<string>())
            .Select(e => e.Trim().ToLowerInvariant())
            .Where(e => e.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (emails.Length == 0) return;

        var prefs = await db.NotificationPreferences.AsNoTracking()
            .Where(p => emails.Contains(p.UserEmail))
            .ToDictionaryAsync(p => p.UserEmail, StringComparer.Ordinal, ct);

        var now = DateTime.UtcNow;
        var created = new List<(string email, Notification row)>();
        foreach (var email in emails)
        {
            var pref = prefs.GetValueOrDefault(email) ?? Defaults(email);
            if (!pref.NotifySystemEvents) continue;

            var n = new Notification
            {
                RecipientEmail = email,
                Type = type,
                Text = text.Length > 512 ? text[..512] : text,
                Link = link,
                IsRead = false,
                CreatedUtc = now,
            };
            db.Notifications.Add(n);
            created.Add((email, n));
        }

        if (created.Count == 0) return;
        await db.SaveChangesAsync(ct);

        foreach (var (email, n) in created)
        {
            await hub.Clients.User(email).SendAsync("ReceiveNotification", ToDto(n), ct);
            var inboxUnread = await db.Notifications.CountAsync(x => x.RecipientEmail == email && !x.IsRead, ct);
            await hub.Clients.User(email).SendAsync("InboxUnreadChanged", inboxUnread, ct);
        }
    }

    private static NotificationPreference Defaults(string email) => new() { UserEmail = email };

    private static string Preview(string body)
    {
        var trimmed = (body ?? "").Trim();
        return trimmed.Length <= 120 ? trimmed : trimmed[..120];
    }

    /// <summary>Map a persisted message to its wire form, never leaking a soft-deleted body.</summary>
    public static ChatMessageDto ToDto(ChatMessage m, string senderName, string? senderPicture) => new()
    {
        Id = m.Id,
        ChannelId = m.ChannelId,
        SenderEmail = m.SenderEmail,
        SenderName = senderName,
        SenderPicture = senderPicture,
        Body = m.DeletedUtc is null ? m.Body : null,
        CreatedUtc = m.CreatedUtc,
        EditedUtc = m.EditedUtc,
        Deleted = m.DeletedUtc is not null,
    };

    private static NotificationDto ToDto(Notification n) => new()
    {
        Id = n.Id,
        Type = NotificationTypeName(n.Type),
        Text = n.Text,
        Link = n.Link,
        ActorEmail = n.ActorEmail,
        ActorName = n.ActorName,
        IsRead = n.IsRead,
        CreatedUtc = n.CreatedUtc,
    };

    /// <summary>The camelCase wire name for a notification type (matches the enum member name).</summary>
    public static string NotificationTypeName(NotificationType type) => type switch
    {
        NotificationType.DirectMessage => "directMessage",
        NotificationType.Mention => "mention",
        NotificationType.ChannelMessage => "channelMessage",
        NotificationType.SystemSyncFailed => "systemSyncFailed",
        NotificationType.SystemUserJoined => "systemUserJoined",
        NotificationType.SystemFleetOffline => "systemFleetOffline",
        _ => "channelMessage",
    };
}
