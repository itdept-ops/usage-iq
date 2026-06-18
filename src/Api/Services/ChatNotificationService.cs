using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Endpoints;
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

    /// <summary>
    /// The single code path that toggles a caller's emoji reaction on a message and broadcasts the
    /// result. Used by BOTH the REST endpoint and the hub so they behave identically. Assumes the
    /// caller has already been authorized (chat.send) and verified as a member of the message's
    /// channel. <paramref name="email"/> and <paramref name="emoji"/> must already be normalized
    /// (lower-cased email; trimmed, validated emoji). Returns the message's full updated reaction
    /// groups (ordered by first-reacted) and pushes <c>ReactionChanged</c> to the channel group.
    /// </summary>
    public async Task<ReactionGroupDto[]> ToggleReactionAsync(
        int channelId, long messageId, string email, string emoji, CancellationToken ct = default)
    {
        var existing = await db.ChatMessageReactions
            .FirstOrDefaultAsync(r => r.MessageId == messageId && r.UserEmail == email && r.Emoji == emoji, ct);
        if (existing is not null)
        {
            db.ChatMessageReactions.Remove(existing);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                // A concurrent toggle already removed this same row (expected 1 affected, got 0). The row
                // is gone, which is the desired end state — drop our tracked delete and converge below.
                db.ChangeTracker.Clear();
            }
        }
        else
        {
            db.ChatMessageReactions.Add(new ChatMessageReaction
            {
                MessageId = messageId, UserEmail = email, Emoji = emoji, CreatedUtc = DateTime.UtcNow,
            });
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (ChatEndpoints.IsUniqueViolation(ex))
            {
                // A concurrent ADD of the same (MessageId, UserEmail, Emoji) won the race (Postgres 23505).
                // The reaction is already present — drop our rejected insert and converge below, so both
                // racers broadcast identical groups. Mirrors GetOrCreateDirectAsync's losing-racer recovery.
                db.ChangeTracker.Clear();
            }
        }

        var groups = (await ReactionGroupsForMessagesAsync(db, new[] { messageId }, ct))
            .GetValueOrDefault(messageId, Array.Empty<ReactionGroupDto>());
        await hub.Clients.Group(GroupFor(channelId)).SendAsync("ReactionChanged", channelId, messageId, groups, ct);
        return groups;
    }

    /// <summary>
    /// Batch-load reaction groups for a page of message ids in ONE query. Returns a map message id →
    /// groups, each group ordered by first-reacted (earliest <see cref="ChatMessageReaction.CreatedUtc"/>)
    /// so chip order is stable. Message ids with no reactions are simply absent from the map (callers
    /// default to an empty array).
    /// </summary>
    public static async Task<Dictionary<long, ReactionGroupDto[]>> ReactionGroupsForMessagesAsync(
        UsageDbContext db, IReadOnlyCollection<long> messageIds, CancellationToken ct = default)
    {
        var result = new Dictionary<long, ReactionGroupDto[]>();
        if (messageIds.Count == 0) return result;

        var rows = await db.ChatMessageReactions.AsNoTracking()
            .Where(r => messageIds.Contains(r.MessageId))
            .Select(r => new { r.MessageId, r.UserEmail, r.Emoji, r.CreatedUtc })
            .ToListAsync(ct);
        if (rows.Count == 0) return result;

        foreach (var byMessage in rows.GroupBy(r => r.MessageId))
        {
            var groups = byMessage
                .GroupBy(r => r.Emoji)
                .Select(g => new
                {
                    Group = new ReactionGroupDto
                    {
                        Emoji = g.Key,
                        Count = g.Count(),
                        ReactedBy = g.OrderBy(r => r.CreatedUtc).Select(r => r.UserEmail).ToArray(),
                    },
                    FirstReacted = g.Min(r => r.CreatedUtc),
                })
                .OrderBy(x => x.FirstReacted)
                .Select(x => x.Group)
                .ToArray();
            result[byMessage.Key] = groups;
        }
        return result;
    }

    /// <summary>
    /// Normalize and validate a reaction emoji: trim, reject empty, cap at 32 chars, and reject any
    /// control/newline character. Returns the trimmed emoji on success, or null with a reason on
    /// failure. Shared by the REST endpoint and the hub so both reject identically.
    /// </summary>
    public static bool TryNormalizeEmoji(string? raw, out string emoji, out string error)
    {
        emoji = (raw ?? "").Trim();
        error = "";
        if (emoji.Length == 0) { error = "An emoji is required."; return false; }
        if (emoji.Length > 32) { error = "That emoji is too long."; return false; }
        if (emoji.Any(char.IsControl)) { error = "That emoji is not valid."; return false; }
        return true;
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
