using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Hubs;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// In-app chat: channels, direct messages, message history, send/edit/delete, and read cursors.
/// Identity comes from the JWT (.RequireAuthorization()); capability from the chat.* permissions
/// (DB-checked). Membership is re-verified per request — a non-member can't read or post, and a
/// GET of a channel they're not in returns 404 (never leak that the channel exists). All emails
/// are compared/stored lower-cased. Message broadcast + notification fan-out go through the shared
/// <see cref="ChatNotificationService"/>, the same path the SignalR hub uses.
/// </summary>
public static class ChatEndpoints
{
    public static void MapChatEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/chat").RequireAuthorization();

        // ---- List my channels + DMs (ordered by last activity), with unread counts ----
        g.MapGet("/channels", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!; // chat.read filter guarantees non-null
            var dtos = await BuildChannelDtosForMemberAsync(db, user.Email, channelId: null, ct);
            return Results.Ok(dtos);
        }).RequirePermission(Permissions.ChatRead);

        // ---- Create a channel (creator auto-joined; unknown/disabled members silently dropped) ----
        g.MapPost("/channels", async (CreateChannelRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var name = (req.Name ?? "").Trim();
            if (name.Length == 0) return Results.BadRequest(new { message = "A channel name is required." });
            if (name.Length > 120) name = name[..120];
            var topic = req.Topic?.Trim();
            if (topic is { Length: > 512 }) topic = topic[..512];

            var now = DateTime.UtcNow;
            var channel = new ChatChannel
            {
                Kind = ChannelKind.Channel,
                Name = name,
                Topic = string.IsNullOrEmpty(topic) ? null : topic,
                IsPrivate = req.IsPrivate,
                CreatedByEmail = user.Email,
                CreatedUtc = now,
            };

            // Validate requested members against existing enabled users; always include the creator.
            var requested = (req.MemberEmails ?? Array.Empty<string>())
                .Select(e => e.Trim().ToLowerInvariant()).Where(e => e.Length > 0)
                .Distinct(StringComparer.Ordinal).ToArray();
            var valid = requested.Length == 0
                ? new List<string>()
                : await db.Users.AsNoTracking()
                    .Where(u => u.IsEnabled && requested.Contains(u.Email))
                    .Select(u => u.Email).ToListAsync(ct);
            var emails = valid.Append(user.Email).Distinct(StringComparer.Ordinal);

            channel.Members = emails.Select(e => new ChatChannelMember
            {
                UserEmail = e, JoinedUtc = now,
            }).ToList();

            db.ChatChannels.Add(channel);
            await db.SaveChangesAsync(ct);

            var dto = (await BuildChannelDtosForMemberAsync(db, user.Email, channel.Id, ct)).First();

            // Tell every member (their other connections / other users) a new channel exists.
            var hub = app.Services.GetRequiredService<IHubContext<ChatHub>>();
            foreach (var m in channel.Members)
            {
                var memberDto = m.UserEmail == user.Email
                    ? dto
                    : (await BuildChannelDtosForMemberAsync(db, m.UserEmail, channel.Id, ct)).First();
                await hub.Clients.User(m.UserEmail).SendAsync("ChannelAdded", memberDto, ct);
            }
            return Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend);

        // ---- Open (get-or-create) a 1:1 DM with another user ----
        g.MapPost("/direct", async (OpenDirectRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var target = (req.UserEmail ?? "").Trim().ToLowerInvariant();
            if (target.Length == 0 || target == user.Email)
                return Results.BadRequest(new { message = "Pick a different user to message." });
            if (!await db.Users.AsNoTracking().AnyAsync(u => u.Email == target && u.IsEnabled, ct))
                return Results.BadRequest(new { message = "That user doesn't exist." });

            var channelId = await GetOrCreateDirectAsync(db, user.Email, target, ct);
            var dto = (await BuildChannelDtosForMemberAsync(db, user.Email, channelId, ct)).First();

            // Surface the new DM to the other participant in real time.
            var hub = app.Services.GetRequiredService<IHubContext<ChatHub>>();
            var otherDto = (await BuildChannelDtosForMemberAsync(db, target, channelId, ct)).First();
            await hub.Clients.User(target).SendAsync("ChannelAdded", otherDto, ct);
            return Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend);

        // ---- Message history (newest-first, cursor by message id) ----
        g.MapGet("/channels/{id:int}/messages", async (
            int id, long? before, int? limit, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            if (!await IsMemberAsync(db, id, user.Email, ct)) return Results.NotFound();

            var take = Math.Clamp(limit ?? 50, 1, 100);
            var q = db.ChatMessages.AsNoTracking().Where(m => m.ChannelId == id);
            if (before is { } cursor) q = q.Where(m => m.Id < cursor);

            var rows = await q.OrderByDescending(m => m.Id).Take(take).ToListAsync(ct);
            var senders = await SenderLookupAsync(db, rows.Select(r => r.SenderEmail), ct);
            var dtos = rows.Select(m =>
            {
                var (nm, pic) = senders.GetValueOrDefault(m.SenderEmail, (m.SenderEmail, (string?)null));
                return ChatNotificationService.ToDto(m, nm, pic);
            }).ToArray();
            return Results.Ok(dtos);
        }).RequirePermission(Permissions.ChatRead);

        // ---- Send a message (persist, broadcast, fan out notifications) ----
        g.MapPost("/channels/{id:int}/messages", async (
            int id, SendMessageRequest req, CurrentUserAccessor me, UsageDbContext db,
            ChatNotificationService fanout, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var channel = await db.ChatChannels.Include(c => c.Members)
                .FirstOrDefaultAsync(c => c.Id == id, ct);
            if (channel is null || channel.Members.All(m => m.UserEmail != user.Email))
                return Results.NotFound();
            if (channel.ArchivedUtc is not null)
                return Results.BadRequest(new { message = "This channel is archived." });

            var body = (req.Body ?? "").Trim();
            if (body.Length == 0) return Results.BadRequest(new { message = "Message body is required." });
            if (body.Length > 4000) body = body[..4000];

            var msg = new ChatMessage
            {
                ChannelId = id, SenderEmail = user.Email, Body = body, CreatedUtc = DateTime.UtcNow,
            };
            db.ChatMessages.Add(msg);
            await db.SaveChangesAsync(ct);

            var (name, pic) = await SenderInfoAsync(db, user.Email, ct);
            var mentions = (req.MentionedEmails ?? Array.Empty<string>());
            await fanout.FanOutMessageAsync(channel, msg, name, pic, mentions, ct);

            return Results.Ok(ChatNotificationService.ToDto(msg, name, pic));
        }).RequirePermission(Permissions.ChatSend).RequireRateLimiting("chat");

        // ---- Edit a message (owner OR moderator) ----
        g.MapPatch("/messages/{id:long}", async (
            long id, EditMessageRequest req, CurrentUserAccessor me, UsageDbContext db,
            IHubContext<ChatHub> hub, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == id, ct);
            if (msg is null || msg.DeletedUtc is not null) return Results.NotFound();
            if (!await IsMemberAsync(db, msg.ChannelId, user.Email, ct)) return Results.NotFound();

            var isOwner = msg.SenderEmail == user.Email;
            if (!isOwner && !user.Permissions.Contains(Permissions.ChatModerate))
                return Results.Json(new { message = "You can only edit your own messages." },
                    statusCode: StatusCodes.Status403Forbidden);

            var body = (req.Body ?? "").Trim();
            if (body.Length == 0) return Results.BadRequest(new { message = "Message body is required." });
            if (body.Length > 4000) body = body[..4000];

            msg.Body = body;
            msg.EditedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            var (name, pic) = await SenderInfoAsync(db, msg.SenderEmail, ct);
            var dto = ChatNotificationService.ToDto(msg, name, pic);
            await hub.Clients.Group(ChatNotificationService.GroupFor(msg.ChannelId)).SendAsync("MessageEdited", dto, ct);
            return Results.Ok(dto);
        }).RequireAnyPermission(Permissions.ChatSend, Permissions.ChatModerate);

        // ---- Delete a message (soft; owner OR moderator) ----
        g.MapDelete("/messages/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, IHubContext<ChatHub> hub, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var msg = await db.ChatMessages.FirstOrDefaultAsync(m => m.Id == id, ct);
            if (msg is null || msg.DeletedUtc is not null) return Results.NotFound();
            if (!await IsMemberAsync(db, msg.ChannelId, user.Email, ct)) return Results.NotFound();

            var isOwner = msg.SenderEmail == user.Email;
            if (!isOwner && !user.Permissions.Contains(Permissions.ChatModerate))
                return Results.Json(new { message = "You can only delete your own messages." },
                    statusCode: StatusCodes.Status403Forbidden);

            msg.DeletedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            await hub.Clients.Group(ChatNotificationService.GroupFor(msg.ChannelId))
                .SendAsync("MessageDeleted", msg.ChannelId, msg.Id, ct);
            return Results.NoContent();
        }).RequireAnyPermission(Permissions.ChatSend, Permissions.ChatModerate);

        // ---- Mark a channel read up to a message id ----
        g.MapPost("/channels/{id:int}/read", async (
            int id, MarkReadRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var member = await db.ChatChannelMembers
                .FirstOrDefaultAsync(m => m.ChannelId == id && m.UserEmail == user.Email, ct);
            if (member is null) return Results.NotFound();

            // The cursor only ever advances (a stale/older id from another tab must not "un-read"),
            // and the message must actually belong to THIS channel (ignore a foreign/forged id).
            if (req.MessageId > (member.LastReadMessageId ?? 0)
                && await db.ChatMessages.AsNoTracking().AnyAsync(m => m.Id == req.MessageId && m.ChannelId == id, ct))
            {
                member.LastReadMessageId = req.MessageId;
                await db.SaveChangesAsync(ct);
            }
            var unread = await UnreadCountAsync(db, id, member.LastReadMessageId, user.Email, ct);
            return Results.Ok(new { unreadCount = unread });
        }).RequirePermission(Permissions.ChatRead);

        // ---- Archive a channel (moderator) ----
        g.MapDelete("/channels/{id:int}", async (int id, UsageDbContext db, CancellationToken ct) =>
        {
            var channel = await db.ChatChannels.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (channel is null) return Results.NotFound();
            if (channel.ArchivedUtc is null)
            {
                channel.ArchivedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }
            return Results.NoContent();
        }).RequirePermission(Permissions.ChatModerate);
    }

    // ===== Shared helpers (also reused by ChatHub) =====

    public static async Task<bool> IsMemberAsync(UsageDbContext db, int channelId, string email, CancellationToken ct) =>
        await db.ChatChannelMembers.AsNoTracking()
            .AnyAsync(m => m.ChannelId == channelId && m.UserEmail == email, ct);

    /// <summary>
    /// Get-or-create the unique Direct channel for an unordered email pair. Two members, null name.
    /// Idempotent under concurrency: a partial unique index on <see cref="ChatChannel.DirectKey"/>
    /// guarantees at most one row; a losing racer catches the unique violation and re-reads the winner.
    /// </summary>
    public static async Task<int> GetOrCreateDirectAsync(UsageDbContext db, string a, string b, CancellationToken ct)
    {
        var key = DirectKeyFor(a, b);

        // Fast path: the DM already exists.
        var existing = await db.ChatChannels.AsNoTracking()
            .Where(c => c.DirectKey == key)
            .Select(c => c.Id)
            .FirstOrDefaultAsync(ct);
        if (existing != 0) return existing;

        var now = DateTime.UtcNow;
        var channel = new ChatChannel
        {
            Kind = ChannelKind.Direct,
            Name = null,
            DirectKey = key,
            IsPrivate = true,
            CreatedByEmail = a,
            CreatedUtc = now,
            Members =
            {
                new ChatChannelMember { UserEmail = a, JoinedUtc = now },
                new ChatChannelMember { UserEmail = b, JoinedUtc = now },
            },
        };
        db.ChatChannels.Add(channel);
        try
        {
            await db.SaveChangesAsync(ct);
            return channel.Id;
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent caller created the same DM between our check and save. Drop our tracked
            // (rejected) entities and return the winning channel.
            db.ChangeTracker.Clear();
            return await db.ChatChannels.AsNoTracking()
                .Where(c => c.DirectKey == key)
                .Select(c => c.Id)
                .FirstAsync(ct);
        }
    }

    /// <summary>Stable DM identity: the two emails lower-cased, ordinal-sorted, joined <c>smaller|larger</c>.</summary>
    public static string DirectKeyFor(string a, string b)
    {
        var x = (a ?? "").Trim().ToLowerInvariant();
        var y = (b ?? "").Trim().ToLowerInvariant();
        return string.CompareOrdinal(x, y) <= 0 ? $"{x}|{y}" : $"{y}|{x}";
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;

    /// <summary>Unread count for a member: messages newer than their cursor, excluding their own.</summary>
    public static Task<int> UnreadCountAsync(UsageDbContext db, int channelId, long? lastRead, string email, CancellationToken ct) =>
        db.ChatMessages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.DeletedUtc == null
                        && m.SenderEmail != email && m.Id > (lastRead ?? 0))
            .CountAsync(ct);

    /// <summary>
    /// Build <c>m =&gt; (m.ChannelId == id1 &amp;&amp; m.Id &gt; cursor1) || (m.ChannelId == id2 &amp;&amp; m.Id &gt; cursor2) || ...</c>
    /// so a single grouped query can apply each channel's own read cursor. An empty map matches nothing.
    /// </summary>
    private static System.Linq.Expressions.Expression<Func<ChatMessage, bool>> BuildUnreadPredicate(
        IReadOnlyDictionary<int, long> cursorByChannel)
    {
        var m = System.Linq.Expressions.Expression.Parameter(typeof(ChatMessage), "m");
        System.Linq.Expressions.Expression body = System.Linq.Expressions.Expression.Constant(false);
        var channelIdProp = System.Linq.Expressions.Expression.Property(m, nameof(ChatMessage.ChannelId));
        var idProp = System.Linq.Expressions.Expression.Property(m, nameof(ChatMessage.Id));
        foreach (var (channelId, cursor) in cursorByChannel)
        {
            var matchesChannel = System.Linq.Expressions.Expression.Equal(
                channelIdProp, System.Linq.Expressions.Expression.Constant(channelId));
            var afterCursor = System.Linq.Expressions.Expression.GreaterThan(
                idProp, System.Linq.Expressions.Expression.Constant(cursor));
            body = System.Linq.Expressions.Expression.OrElse(
                body, System.Linq.Expressions.Expression.AndAlso(matchesChannel, afterCursor));
        }
        return System.Linq.Expressions.Expression.Lambda<Func<ChatMessage, bool>>(body, m);
    }

    /// <summary>
    /// Build <see cref="ChatChannelDto"/>s for every active channel the given member belongs to (or a
    /// single channel when <paramref name="channelId"/> is set), ordered by last-message time desc.
    /// </summary>
    public static async Task<List<ChatChannelDto>> BuildChannelDtosForMemberAsync(
        UsageDbContext db, string email, int? channelId, CancellationToken ct)
    {
        var channelsQ = db.ChatChannels.AsNoTracking()
            .Where(c => c.ArchivedUtc == null && c.Members.Any(m => m.UserEmail == email));
        if (channelId is { } cid) channelsQ = channelsQ.Where(c => c.Id == cid);

        var channels = await channelsQ
            .Select(c => new
            {
                c.Id, c.Kind, c.Name, c.Topic, c.IsPrivate, c.ArchivedUtc,
                Members = c.Members.Select(m => m.UserEmail).ToList(),
                MyLastRead = c.Members.Where(m => m.UserEmail == email).Select(m => m.LastReadMessageId).FirstOrDefault(),
            })
            .ToListAsync(ct);
        if (channels.Count == 0) return new();

        var ids = channels.Select(c => c.Id).ToArray();

        // Unread per channel in ONE grouped query: non-deleted messages from someone other than the
        // caller, newer than the caller's per-channel read cursor, grouped by channel. Building the
        // cursor comparison as a per-channel OR over an expression tree lets Npgsql evaluate it
        // server-side, so the result is identical to UnreadCountAsync run for each channel.
        var unreadPredicate = BuildUnreadPredicate(channels.ToDictionary(c => c.Id, c => c.MyLastRead ?? 0L));
        var unreadById = (await db.ChatMessages.AsNoTracking()
                .Where(m => m.DeletedUtc == null && m.SenderEmail != email)
                .Where(unreadPredicate)
                .GroupBy(m => m.ChannelId)
                .Select(g => new { ChannelId = g.Key, Count = g.Count() })
                .ToListAsync(ct))
            .ToDictionary(x => x.ChannelId, x => x.Count);

        // Last (non-deleted-aware) message per channel.
        var lastMsgIds = await db.ChatMessages.AsNoTracking()
            .Where(m => ids.Contains(m.ChannelId))
            .GroupBy(m => m.ChannelId)
            .Select(grp => grp.Max(m => m.Id))
            .ToListAsync(ct);
        var lastMsgs = await db.ChatMessages.AsNoTracking()
            .Where(m => lastMsgIds.Contains(m.Id))
            .ToDictionaryAsync(m => m.ChannelId, ct);

        // Identity lookup for every distinct participant + last-message sender.
        var allEmails = channels.SelectMany(c => c.Members)
            .Concat(lastMsgs.Values.Select(m => m.SenderEmail))
            .Distinct(StringComparer.Ordinal).ToArray();
        var people = await SenderLookupAsync(db, allEmails, ct);

        var result = new List<ChatChannelDto>();
        foreach (var c in channels)
        {
            var members = c.Members.Select(e =>
            {
                var (nm, pic) = people.GetValueOrDefault(e, (e, (string?)null));
                return new MemberDto { Email = e, Name = nm, Picture = pic };
            }).ToArray();

            ChatMessageDto? lastDto = null;
            if (lastMsgs.TryGetValue(c.Id, out var lm))
            {
                var (nm, pic) = people.GetValueOrDefault(lm.SenderEmail, (lm.SenderEmail, (string?)null));
                lastDto = ChatNotificationService.ToDto(lm, nm, pic);
            }

            var unread = unreadById.GetValueOrDefault(c.Id, 0);

            string display = c.Kind == ChannelKind.Direct
                ? (members.FirstOrDefault(m => m.Email != email) is { } other
                    ? (string.IsNullOrEmpty(other.Name) ? other.Email : other.Name)
                    : (members.FirstOrDefault()?.Name ?? email))
                : (c.Name ?? "");

            result.Add(new ChatChannelDto
            {
                Id = c.Id,
                Kind = c.Kind == ChannelKind.Direct ? "direct" : "channel",
                Name = c.Name,
                Topic = c.Topic,
                IsPrivate = c.IsPrivate,
                Archived = c.ArchivedUtc is not null,
                DisplayName = display,
                Members = members,
                LastMessage = lastDto,
                UnreadCount = unread,
            });
        }

        // Newest activity first; channels with no messages fall back to channel id order.
        return result
            .OrderByDescending(c => c.LastMessage?.CreatedUtc ?? DateTime.MinValue)
            .ThenByDescending(c => c.Id)
            .ToList();
    }

    /// <summary>Resolve display name + picture for a set of emails (falls back to the email as name).</summary>
    public static async Task<Dictionary<string, (string Name, string? Picture)>> SenderLookupAsync(
        UsageDbContext db, IEnumerable<string> emails, CancellationToken ct)
    {
        var distinct = emails.Where(e => !string.IsNullOrEmpty(e)).Distinct(StringComparer.Ordinal).ToArray();
        if (distinct.Length == 0) return new(StringComparer.Ordinal);

        return await db.Users.AsNoTracking()
            .Where(u => distinct.Contains(u.Email))
            .ToDictionaryAsync(
                u => u.Email,
                u => (string.IsNullOrEmpty(u.Name) ? u.Email : u.Name, u.Picture),
                StringComparer.Ordinal, ct);
    }

    private static async Task<(string Name, string? Picture)> SenderInfoAsync(UsageDbContext db, string email, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking()
            .Where(x => x.Email == email)
            .Select(x => new { x.Name, x.Picture })
            .FirstOrDefaultAsync(ct);
        return u is null ? (email, null) : (string.IsNullOrEmpty(u.Name) ? email : u.Name, u.Picture);
    }
}
