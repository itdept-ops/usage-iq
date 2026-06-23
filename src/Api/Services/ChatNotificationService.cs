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
public sealed class ChatNotificationService(UsageDbContext db, IHubContext<ChatHub> hub, DiscordForwarder discord)
{
    /// <summary>Group name a connection joins for every channel it belongs to.</summary>
    public static string GroupFor(int channelId) => $"channel:{channelId}";

    /// <summary>
    /// Broadcast a freshly persisted message to the channel group and fan notifications out to every
    /// OTHER member (gated by their preferences + mute window). At most one notification row per
    /// (recipient, message). <paramref name="mentionedUserIds"/> are AppUser ids (email-privacy: the
    /// client holds no other-user emails); they're resolved to emails here and intersected with channel
    /// membership, so only mentions of actual members fire a "you were mentioned" notification.
    /// </summary>
    public async Task FanOutMessageAsync(
        ChatChannel channel, ChatMessage message, SenderIdentity sender,
        IReadOnlyCollection<int> mentionedUserIds, CancellationToken ct = default)
    {
        var senderName = sender.Name;
        var dto = ToDto(message, sender);

        // Real-time: everyone in the channel (including the sender's other connections) sees it.
        await hub.Clients.Group(GroupFor(channel.Id)).SendAsync("ReceiveMessage", dto, ct);

        // Members other than the sender, with their per-channel read cursor + mute window.
        var members = await db.ChatChannelMembers.AsNoTracking()
            .Where(m => m.ChannelId == channel.Id && m.UserEmail != message.SenderEmail)
            .ToListAsync(ct);
        if (members.Count == 0) return;

        var memberEmails = members.Select(m => m.UserEmail).ToHashSet(StringComparer.Ordinal);

        // Resolve the mentioned AppUser ids -> internal email, then keep only those who are actual channel
        // members — never notify outsiders, and the raw email never came from the client (email-privacy).
        var mentionedEmails = (mentionedUserIds is { Count: > 0 })
            ? await ResolveEmailsByIdAsync(db, mentionedUserIds, ct)
            : new Dictionary<int, string>();
        var validMentions = mentionedEmails.Values
            .Where(e => memberEmails.Contains(e))
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
        // UnreadChanged(channelId, perChannelMessageCount) always means exactly that. Compute all
        // members' per-channel unread counts from ONE query instead of a COUNT per member (N+1): pull
        // the channel's non-deleted message id+sender newer than the SMALLEST member cursor once, then
        // bucket per member in memory. Each member's count is identical to the previous per-member COUNT
        // (Id > their own cursor, excluding their own messages); members at/above the min cursor simply
        // skip the rows below their cursor in memory.
        var minCursor = members.Min(m => m.LastReadMessageId ?? 0L);
        var unreadCandidates = await db.ChatMessages.AsNoTracking()
            .Where(m => m.ChannelId == channel.Id && m.DeletedUtc == null && m.Id > minCursor)
            .Select(m => new { m.Id, m.SenderEmail })
            .ToListAsync(ct);
        foreach (var member in members)
        {
            var cursor = member.LastReadMessageId ?? 0L;
            var unreadMessages = unreadCandidates.Count(
                m => m.Id > cursor && !string.Equals(m.SenderEmail, member.UserEmail, StringComparison.Ordinal));
            await hub.Clients.User(member.UserEmail)
                .SendAsync("UnreadChanged", channel.Id, unreadMessages, ct);
        }

        // Resolve the actor (the sender) to AppUser id + name once — the raw email never reaches the client.
        var actor = (await ResolveActorsAsync(db, new[] { message.SenderEmail }, ct))
            .TryGetValue(message.SenderEmail.ToLowerInvariant(), out var ai) ? ai : (ActorIdentity?)null;

        // Recipients who actually got an inbox notification row also get their global inbox total.
        // One grouped query for every recipient's unread total instead of a COUNT per recipient (N+1).
        var inboxUnreadByEmail = await UnreadInboxCountsAsync(created.Select(c => c.email), ct);
        foreach (var (email, n) in created)
        {
            await hub.Clients.User(email).SendAsync("ReceiveNotification", ToDto(n, actor), ct);
            await hub.Clients.User(email)
                .SendAsync("InboxUnreadChanged", inboxUnreadByEmail.GetValueOrDefault(email, 0), ct);
            // Fire-and-forget: mirror this notification to the recipient's personal Discord webhook if they
            // opted in. Enqueue only — never block/slow/fail the fan-out; the worker gates on their prefs.
            discord.Enqueue(new DiscordForwardItem(email, NotificationTypeName(n.Type), actor?.Name, n.Text, n.Link));
        }
    }

    /// <summary>
    /// Per-recipient unread inbox totals in ONE grouped query instead of a COUNT per recipient (N+1).
    /// Returns a map recipient email → unread count; recipients with no unread rows are absent (callers
    /// default to 0). The emitted per-recipient count is identical to the previous per-email COUNT.
    /// </summary>
    private async Task<Dictionary<string, int>> UnreadInboxCountsAsync(
        IEnumerable<string> recipientEmails, CancellationToken ct)
    {
        var emails = recipientEmails.Distinct(StringComparer.Ordinal).ToArray();
        if (emails.Length == 0) return new Dictionary<string, int>(StringComparer.Ordinal);

        var rows = await db.Notifications.AsNoTracking()
            .Where(n => emails.Contains(n.RecipientEmail) && !n.IsRead)
            .GroupBy(n => n.RecipientEmail)
            .Select(g => new { Email = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        return rows.ToDictionary(x => x.Email, x => x.Count, StringComparer.Ordinal);
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

        // System events carry no actor (ActorEmail is null) — the actor fields stay null.
        var inboxUnreadByEmail = await UnreadInboxCountsAsync(created.Select(c => c.email), ct);
        foreach (var (email, n) in created)
        {
            await hub.Clients.User(email).SendAsync("ReceiveNotification", ToDto(n, (ActorIdentity?)null), ct);
            await hub.Clients.User(email)
                .SendAsync("InboxUnreadChanged", inboxUnreadByEmail.GetValueOrDefault(email, 0), ct);
            // Fire-and-forget Discord mirror for opted-in recipients (no actor on a system event).
            discord.Enqueue(new DiscordForwardItem(email, NotificationTypeName(n.Type), null, n.Text, n.Link));
        }
    }

    /// <summary>
    /// Deliver a Family Hub alert (reminder due / shared timer finished) to a set of household members,
    /// addressed by their AppUser id (email-privacy: the Family world never holds other-user emails — ids
    /// are resolved to the internal email here). Persists one inbox <see cref="Notification"/> row per
    /// recipient and pushes <c>ReceiveNotification</c> + <c>InboxUnreadChanged</c> to each — the SAME path
    /// the chat fan-out uses, so the alert lands in their bell + toast + unread count. Unlike
    /// <see cref="NotifySystem"/>, these are explicitly user-scheduled alerts, so they are NOT gated on a
    /// notification preference (a reminder the user set must never be silently dropped). Returns the number
    /// of rows actually written (recipients whose id resolved to an enabled user).
    /// </summary>
    public async Task<int> NotifyFamily(
        IEnumerable<int> recipientUserIds, NotificationType type, string text, string? link,
        CancellationToken ct = default)
    {
        var ids = (recipientUserIds ?? Enumerable.Empty<int>()).Where(id => id > 0).Distinct().ToArray();
        if (ids.Length == 0) return 0;

        // Resolve ids -> internal (lower-cased) email, enabled users only. The email never crosses the wire.
        var emailById = await ResolveEmailsByIdAsync(db, ids, ct);
        if (emailById.Count == 0) return 0;

        var now = DateTime.UtcNow;
        var clamped = text.Length > 512 ? text[..512] : text;
        var created = new List<(string email, Notification row)>();
        foreach (var email in emailById.Values.Select(e => e.ToLowerInvariant()).Distinct(StringComparer.Ordinal))
        {
            var n = new Notification
            {
                RecipientEmail = email,
                Type = type,
                Text = clamped,
                Link = link,
                IsRead = false,
                CreatedUtc = now,
            };
            db.Notifications.Add(n);
            created.Add((email, n));
        }

        if (created.Count == 0) return 0;
        await db.SaveChangesAsync(ct);

        // Family alerts carry no actor (the scheduler, not a person, fired them) — actor fields stay null.
        var inboxUnreadByEmail = await UnreadInboxCountsAsync(created.Select(c => c.email), ct);
        foreach (var (email, n) in created)
        {
            await hub.Clients.User(email).SendAsync("ReceiveNotification", ToDto(n, (ActorIdentity?)null), ct);
            await hub.Clients.User(email)
                .SendAsync("InboxUnreadChanged", inboxUnreadByEmail.GetValueOrDefault(email, 0), ct);
            // Fire-and-forget Discord mirror for opted-in recipients (no actor on a family alert).
            discord.Enqueue(new DiscordForwardItem(email, NotificationTypeName(n.Type), null, n.Text, n.Link));
        }
        return created.Count;
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

        // Resolve every distinct reactor email -> AppUser id ONCE (email-privacy: the raw reactor email
        // never reaches the client). Emails with no AppUser row contribute id 0.
        var userIdByEmail = await ResolveUserIdsAsync(db, rows.Select(r => r.UserEmail), ct);

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
                        ReactedByUserIds = g.OrderBy(r => r.CreatedUtc)
                            .Select(r => userIdByEmail.GetValueOrDefault(r.UserEmail, 0)).ToArray(),
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

    /// <summary>The server-resolved public identity of a message sender / channel member: the AppUser id
    /// (0 when the email has no AppUser row), a display name that is NEVER an email (email-privacy), and an
    /// optional picture.</summary>
    public readonly record struct SenderIdentity(int Id, string Name, string? Picture);

    /// <summary>Map a persisted message to its wire form, never leaking a soft-deleted body. The sender is
    /// exposed as <see cref="ChatMessageDto.SenderUserId"/> + name/picture — the raw email never reaches
    /// the client (email-privacy).</summary>
    public static ChatMessageDto ToDto(ChatMessage m, SenderIdentity sender) => new()
    {
        Id = m.Id,
        ChannelId = m.ChannelId,
        SenderUserId = sender.Id,
        SenderName = sender.Name,
        SenderPicture = sender.Picture,
        Body = m.DeletedUtc is null ? m.Body : null,
        CreatedUtc = m.CreatedUtc,
        EditedUtc = m.EditedUtc,
        Deleted = m.DeletedUtc is not null,
    };

    /// <summary>The server-resolved public identity of a notification's actor: the AppUser id and a
    /// display name that is NEVER an email (email-privacy).</summary>
    public readonly record struct ActorIdentity(int Id, string Name);

    /// <summary>
    /// Map a notification to its wire form. The actor is exposed as <see cref="NotificationDto.ActorUserId"/>
    /// + <see cref="NotificationDto.ActorName"/>, both server-resolved from the actor email — the raw
    /// <see cref="Notification.ActorEmail"/> is NEVER put on the wire (email-privacy). <paramref name="actor"/>
    /// is null when there is no actor (system event) or the actor email has no AppUser row; in that case the
    /// actor fields are null rather than ever falling back to the email.
    /// </summary>
    public static NotificationDto ToDto(Notification n, ActorIdentity? actor) => new()
    {
        Id = n.Id,
        Type = NotificationTypeName(n.Type),
        Text = n.Text,
        Link = n.Link,
        ActorUserId = actor?.Id,
        ActorName = actor?.Name,
        IsRead = n.IsRead,
        CreatedUtc = n.CreatedUtc,
    };

    /// <summary>
    /// Resolve a set of actor emails to their AppUser id + display name in one query (lower-cased match).
    /// The name is the AppUser.Name, falling back to "Unknown user" — NEVER the email (email-privacy).
    /// Emails with no AppUser row are simply absent from the map. Shared by the inbox load and the realtime
    /// fan-out so the actor identity is resolved identically.
    /// </summary>
    public static async Task<Dictionary<string, ActorIdentity>> ResolveActorsAsync(
        UsageDbContext db, IReadOnlyCollection<string> actorEmails, CancellationToken ct = default)
    {
        var emails = actorEmails
            .Where(e => !string.IsNullOrEmpty(e))
            .Select(e => e.ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (emails.Length == 0) return new Dictionary<string, ActorIdentity>(StringComparer.Ordinal);

        var rows = await db.Users.AsNoTracking()
            .Where(u => emails.Contains(u.Email))
            .Select(u => new { u.Email, u.Id, u.Name })
            .ToListAsync(ct);

        return rows.ToDictionary(
            x => x.Email,
            x => new ActorIdentity(x.Id, string.IsNullOrEmpty(x.Name) ? "Unknown user" : x.Name),
            StringComparer.Ordinal);
    }

    /// <summary>
    /// Resolve a set of emails to their AppUser id in ONE query (lower-cased match). Emails with no
    /// AppUser row are simply absent from the map (callers default to id 0). Shared by the reaction
    /// grouping (and any caller that needs only the id, not name/picture).
    /// </summary>
    public static async Task<Dictionary<string, int>> ResolveUserIdsAsync(
        UsageDbContext db, IEnumerable<string> emails, CancellationToken ct = default)
    {
        var distinct = emails
            .Where(e => !string.IsNullOrEmpty(e))
            .Select(e => e.ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (distinct.Length == 0) return new Dictionary<string, int>(StringComparer.Ordinal);

        return await db.Users.AsNoTracking()
            .Where(u => distinct.Contains(u.Email))
            .ToDictionaryAsync(u => u.Email, u => u.Id, StringComparer.Ordinal, ct);
    }

    /// <summary>
    /// The INBOUND counterpart of <see cref="ResolveUserIdsAsync"/>: resolve a set of AppUser ids to their
    /// internal (lower-cased) email in ONE query, keeping only ENABLED users. Ids that don't exist or are
    /// disabled are simply absent from the map. Used by the chat inbound paths (open-DM, create-channel,
    /// mention fan-out, contacts admin) where the client sends ids and the server must recover the email
    /// it keys storage/membership/addressing by — the email never crosses the wire (email-privacy).
    /// </summary>
    public static async Task<Dictionary<int, string>> ResolveEmailsByIdAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct = default)
    {
        var distinct = userIds.Where(id => id > 0).Distinct().ToArray();
        if (distinct.Length == 0) return new Dictionary<int, string>();

        return await db.Users.AsNoTracking()
            .Where(u => u.IsEnabled && distinct.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.Email, ct);
    }

    /// <summary>The camelCase wire name for a notification type (matches the enum member name).</summary>
    public static string NotificationTypeName(NotificationType type) => type switch
    {
        NotificationType.DirectMessage => "directMessage",
        NotificationType.Mention => "mention",
        NotificationType.ChannelMessage => "channelMessage",
        NotificationType.SystemSyncFailed => "systemSyncFailed",
        NotificationType.SystemUserJoined => "systemUserJoined",
        NotificationType.SystemFleetOffline => "systemFleetOffline",
        NotificationType.FamilyReminder => "familyReminder",
        NotificationType.FamilyTimer => "familyTimer",
        NotificationType.FamilyBriefing => "familyBriefing",
        NotificationType.FamilyHeadsUp => "familyHeadsUp",
        _ => "channelMessage",
    };
}
