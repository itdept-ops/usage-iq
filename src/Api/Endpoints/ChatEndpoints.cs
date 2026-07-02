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

            // Resolve requested member IDs -> internal emails (enabled-only); unknown/disabled ids drop out.
            // Always include the creator. The client holds no other-user emails (email-privacy).
            // Cap the unbounded id array before the DB query (mirrors the string clamps above).
            var memberIds = (req.MemberUserIds ?? Array.Empty<int>()).Distinct().Take(200).ToArray();
            var resolved = await ChatNotificationService.ResolveEmailsByIdAsync(db, memberIds, ct);
            var emails = resolved.Values.Append(user.Email).Distinct(StringComparer.Ordinal);

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
            // The other participant is sent by AppUser id (email-privacy); resolve it to the internal email,
            // validating the user exists + is enabled.
            var target = req.UserId <= 0
                ? null
                : await db.Users.AsNoTracking()
                    .Where(u => u.Id == req.UserId && u.IsEnabled).Select(u => u.Email).FirstOrDefaultAsync(ct);
            if (target == user.Email)
                return Results.BadRequest(new { message = "Pick a different user to message." });

            // A non-existent/disabled id is a plain 400 "doesn't exist". A non-admin may then only DM
            // someone in their mutual contact circle (the same people their New-DM picker draws from);
            // a valid-but-non-contact id gets a 403 telling them to add the person first. Chat admins
            // (chat.contacts.manage — the capability that lets their picker draw from the full team
            // directory) bypass the contact gate and may DM anyone enabled. (Distinguishing "unknown"
            // from "not a contact" mirrors the existing contacts UX; tightening this into a single
            // uniform response to remove the id-enumeration signal is a deferred product decision.)
            if (target is null)
                return Results.BadRequest(new { message = "That user doesn't exist." });
            var isChatAdmin = user.Permissions.Contains(Permissions.ChatContactsManage);
            var isContact = await ContactGraph.IsContactAsync(db, user.Email, target, ct);
            if (!isChatAdmin && !isContact)
                return Results.Json(
                    new { message = "You can only message your contacts. Ask an admin to add them to your circle." },
                    statusCode: StatusCodes.Status403Forbidden);

            var channelId = await GetOrCreateDirectAsync(db, user.Email, target, ct);
            var dto = (await BuildChannelDtosForMemberAsync(db, user.Email, channelId, ct)).FirstOrDefault();
            if (dto is null) return Results.NotFound();

            // Surface the new DM to the other participant in real time.
            var hub = app.Services.GetRequiredService<IHubContext<ChatHub>>();
            var otherDto = (await BuildChannelDtosForMemberAsync(db, target, channelId, ct)).FirstOrDefault();
            if (otherDto is not null)
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
            // Batch-load every reaction for this page of messages in ONE query.
            var reactions = await ChatNotificationService.ReactionGroupsForMessagesAsync(
                db, rows.Select(r => r.Id).ToArray(), ct);
            var dtos = rows.Select(m =>
            {
                var sender = senders.GetValueOrDefault(m.SenderEmail, UnknownSender);
                var dto = ChatNotificationService.ToDto(m, sender);
                dto.Reactions = reactions.GetValueOrDefault(m.Id, Array.Empty<ReactionGroupDto>());
                return dto;
            }).ToArray();
            return Results.Ok(dtos);
        }).RequirePermission(Permissions.ChatRead);

        // ---- AI: "Catch me up" — summarise the channel's recent messages (read-only) ----
        // Gated chat.read + MEMBERSHIP (non-member 404). Builds a names-only transcript (NO email; deleted
        // bodies excluded) and asks Gemini to summarise. ALWAYS 200: a deterministic plain floor covers an
        // unconfigured/failed Gemini (fellBackToPlain=true) — this route NEVER 503/500s. WRITES NOTHING.
        g.MapPost("/channels/{id:int}/ai/catch-up", async (
            int id, CurrentUserAccessor me, UsageDbContext db, GeminiService gemini, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            if (!await IsMemberAsync(db, id, user.Email, ct)) return Results.NotFound();

            var (channelName, ordered, namesNewestFirst) = await LoadChatContextAsync(db, id, ct);

            // Try Gemini; on any miss fall back to the guaranteed deterministic plain floor.
            var summary = await gemini.SummarizeChatAsync(ordered, channelName, ct);
            if (!string.IsNullOrWhiteSpace(summary))
                return Results.Ok(new { summary, fellBackToPlain = false });

            return Results.Ok(new { summary = PlainCatchUp(namesNewestFirst), fellBackToPlain = true });
        }).RequirePermission(Permissions.ChatRead).RequirePermission(Permissions.ChatAi)
          .RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- AI: "Smart replies" — suggest reply options for the caller (read-only; SENDS NOTHING) ----
        // Gated chat.send + MEMBERSHIP (non-member 404). Returns 2-4 suggestions for the composer; the user
        // sends via the EXISTING path. 503-graceful (no floor — empty/unavailable is fine). WRITES NOTHING.
        g.MapPost("/channels/{id:int}/ai/replies", async (
            int id, CurrentUserAccessor me, UsageDbContext db, GeminiService gemini, CancellationToken ct) =>
        {
            // Membership is checked FIRST so a non-member always gets 404 (existence never leaked), even when
            // Gemini is unconfigured — the 503 must never reveal whether the channel exists.
            var user = (await me.GetUserAsync(ct))!;
            if (!await IsMemberAsync(db, id, user.Email, ct)) return Results.NotFound();
            if (!gemini.IsConfigured) return AiUnavailable();

            var (_, ordered, _) = await LoadChatContextAsync(db, id, ct);
            var myName = (await SenderInfoAsync(db, user.Email, ct)).Name;

            var replies = await gemini.SuggestRepliesAsync(ordered, myName, ct);
            if (replies is null) return AiUnavailable();
            return Results.Ok(new { replies });
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.ChatAi)
          .RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- AI: "Compose assist" — draft/rewrite/shorten/friendlier/formal a message (SENDS NOTHING) ----
        // Gated chat.send (no channel — the composer hasn't picked one yet). Returns the composed text for the
        // composer; the user sends via the EXISTING path. 400 when there's nothing to work from (empty prompt
        // AND empty draft) or an unknown action; 503-graceful otherwise. WRITES NOTHING.
        g.MapPost("/ai/compose", async (
            ComposeAssistRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            var action = (req.Action ?? "").Trim().ToLowerInvariant();
            if (!ChatComposeActions.Contains(action))
                return Results.BadRequest(new { message = "Unknown compose action." });

            var prompt = (req.Prompt ?? "").Trim();
            var draft = (req.CurrentDraft ?? "").Trim();
            var hasSomething = action == "draft" ? prompt.Length > 0 : draft.Length > 0;
            if (!hasSomething)
                return Results.BadRequest(new { message = "Type a prompt or a draft to work from." });

            if (!gemini.IsConfigured) return AiUnavailable();

            var body = await gemini.ComposeChatAsync(prompt, draft, action, ct);
            if (string.IsNullOrWhiteSpace(body)) return AiUnavailable();
            return Results.Ok(new { body });
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.ChatAi)
          .RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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

            // The mutual-contact gate is durable, not just enforced at first-DM creation: removing the
            // contact edge must cut off the existing DM too. Re-check it on every Direct send (the /direct
            // creation path checks the same thing). Chat admins (chat.contacts.manage) bypass, as there.
            if (channel.Kind == ChannelKind.Direct
                && !user.Permissions.Contains(Permissions.ChatContactsManage))
            {
                var other = channel.Members.FirstOrDefault(m => m.UserEmail != user.Email)?.UserEmail;
                if (other is null || !await ContactGraph.IsContactAsync(db, user.Email, other, ct))
                    return Results.Json(
                        new { message = "You can only message your contacts. Ask an admin to add them to your circle." },
                        statusCode: StatusCodes.Status403Forbidden);
            }

            var body = (req.Body ?? "").Trim();
            if (body.Length == 0) return Results.BadRequest(new { message = "Message body is required." });
            if (body.Length > 4000) body = body[..4000];

            var msg = new ChatMessage
            {
                ChannelId = id, SenderEmail = user.Email, Body = body, CreatedUtc = DateTime.UtcNow,
            };
            db.ChatMessages.Add(msg);
            await db.SaveChangesAsync(ct);

            var sender = await SenderInfoAsync(db, user.Email, ct);
            // Cap the unbounded id array before the DB resolve (mirrors the string clamps above).
            var mentions = (req.MentionedUserIds ?? Array.Empty<int>()).Distinct().Take(50).ToArray();
            await fanout.FanOutMessageAsync(channel, msg, sender, mentions, ct);

            return Results.Ok(ChatNotificationService.ToDto(msg, sender));
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

            var sender = await SenderInfoAsync(db, msg.SenderEmail, ct);
            var dto = ChatNotificationService.ToDto(msg, sender);
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

        // ---- Toggle an emoji reaction on a message (add if absent, remove if present) ----
        g.MapPost("/messages/{id:long}/reactions", async (
            long id, ReactRequest req, CurrentUserAccessor me, UsageDbContext db,
            ChatNotificationService reactions, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;

            if (!ChatNotificationService.TryNormalizeEmoji(req.Emoji, out var emoji, out var error))
                return Results.BadRequest(new { message = error });

            // 404 if the message doesn't exist OR the caller isn't a member of its channel
            // (never leak that a message in a channel they can't see exists).
            var msg = await db.ChatMessages.AsNoTracking()
                .Where(m => m.Id == id)
                .Select(m => new { m.Id, m.ChannelId })
                .FirstOrDefaultAsync(ct);
            if (msg is null || !await IsMemberAsync(db, msg.ChannelId, user.Email, ct))
                return Results.NotFound();

            var groups = await reactions.ToggleReactionAsync(msg.ChannelId, msg.Id, user.Email, emoji, ct);
            return Results.Ok(groups);
        }).RequirePermission(Permissions.ChatSend).RequireRateLimiting("chat");

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

        // Fast path: the DM already exists. Do NOT auto-clear ArchivedUtc here: archiving is a
        // chat.moderate-gated action used to shut a conversation down, and re-opening the DM only
        // needs chat.send + a contact edge — reviving on this path would let a non-privileged user
        // silently undo a moderator's archive. Leave it archived; BuildChannelDtosForMemberAsync
        // filters archived rows out, so the caller's FirstOrDefault() is null and it returns 404
        // (the archived channel stays retired until a moderator un-archives it).
        var existing = await db.ChatChannels
            .Where(c => c.DirectKey == key)
            .Select(c => new { c.Id, c.ArchivedUtc })
            .FirstOrDefaultAsync(ct);
        if (existing is not null)
            return existing.Id;

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

    /// <summary>True when a save failed on a Postgres unique-index violation (23505) — the signal a
    /// concurrent caller won an insert race. Shared with <see cref="ChatNotificationService"/>.</summary>
    internal static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;

    /// <summary>Unread count for a member: messages newer than their cursor, excluding their own.</summary>
    public static Task<int> UnreadCountAsync(UsageDbContext db, int channelId, long? lastRead, string email, CancellationToken ct)
    {
        // Coalesce the (nullable) cursor to a plain long BEFORE the query so EF sees `m.Id > cursor`
        // (long vs long), not `m.Id > (long?)` — the latter fails to translate ("GreaterThan is not
        // defined for Int64 and Nullable<Int64>") and 500s the read/unread flow.
        var cursor = lastRead ?? 0L;
        return db.ChatMessages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.DeletedUtc == null
                        && m.SenderEmail != email && m.Id > cursor)
            .CountAsync(ct);
    }

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

        // Identity lookup for every distinct participant + last-message sender (email -> AppUser id+name+pic).
        var allEmails = channels.SelectMany(c => c.Members)
            .Concat(lastMsgs.Values.Select(m => m.SenderEmail))
            .Distinct(StringComparer.Ordinal).ToArray();
        var people = await SenderLookupAsync(db, allEmails, ct);

        // The caller's own AppUser id, so self/"other member" comparisons key off id, not email
        // (0 only if the caller somehow has no AppUser row — they're always a member, so present here).
        var myUserId = people.GetValueOrDefault(email, UnknownSender).Id;

        var result = new List<ChatChannelDto>();
        foreach (var c in channels)
        {
            var members = c.Members.Select(e =>
            {
                var who = people.GetValueOrDefault(e, UnknownSender);
                return new MemberDto { UserId = who.Id, Name = who.Name, Picture = who.Picture };
            }).ToArray();

            ChatMessageDto? lastDto = null;
            if (lastMsgs.TryGetValue(c.Id, out var lm))
            {
                var lmSender = people.GetValueOrDefault(lm.SenderEmail, UnknownSender);
                lastDto = ChatNotificationService.ToDto(lm, lmSender);
            }

            var unread = unreadById.GetValueOrDefault(c.Id, 0);

            // The OTHER member of a DM is the one whose AppUser id differs from the caller's (by id, never
            // email). Fall back to the first member when the pair can't be distinguished by id.
            string display = c.Kind == ChannelKind.Direct
                ? (members.FirstOrDefault(m => m.UserId != myUserId) is { } other
                    ? (string.IsNullOrEmpty(other.Name) ? "Unknown user" : other.Name)
                    : (members.FirstOrDefault()?.Name ?? "Unknown user"))
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

    /// <summary>
    /// Resolve AppUser id + display name + picture for a set of emails in ONE query. An email with no
    /// AppUser row is absent from the map; callers default to <c>(0, "Unknown user", null)</c> — the raw
    /// email is NEVER used as the display identity (email-privacy).
    /// </summary>
    public static async Task<Dictionary<string, ChatNotificationService.SenderIdentity>> SenderLookupAsync(
        UsageDbContext db, IEnumerable<string> emails, CancellationToken ct)
    {
        var distinct = emails.Where(e => !string.IsNullOrEmpty(e)).Distinct(StringComparer.Ordinal).ToArray();
        if (distinct.Length == 0) return new(StringComparer.Ordinal);

        var rows = await db.Users.AsNoTracking()
            .Where(u => distinct.Contains(u.Email))
            .Select(u => new { u.Email, u.Id, u.Name, u.DisplayNameMode, u.Nickname, u.Picture })
            .ToListAsync(ct);

        return rows.ToDictionary(
            u => u.Email,
            u => new ChatNotificationService.SenderIdentity(
                u.Id, DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname), u.Picture),
            StringComparer.Ordinal);
    }

    /// <summary>The fallback identity for an email with no AppUser row: id 0, name "Unknown user", no picture.</summary>
    private static ChatNotificationService.SenderIdentity UnknownSender => new(0, "Unknown user", null);

    private static async Task<ChatNotificationService.SenderIdentity> SenderInfoAsync(UsageDbContext db, string email, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking()
            .Where(x => x.Email == email)
            .Select(x => new { x.Id, x.Name, x.DisplayNameMode, x.Nickname, x.Picture })
            .FirstOrDefaultAsync(ct);
        return u is null
            ? UnknownSender
            : new ChatNotificationService.SenderIdentity(u.Id, DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname), u.Picture);
    }

    // ===== Chat-AI helpers (catch-up / smart-replies) =====

    /// <summary>How many newest messages the chat-AI features read for context.</summary>
    private const int ChatAiContextSize = 60;

    /// <summary>The compose actions the /ai/compose endpoint accepts (mirrors the service's set).</summary>
    private static readonly IReadOnlySet<string> ChatComposeActions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "draft", "rewrite", "shorten", "friendlier", "formal" };

    /// <summary>The compose-assist request: a free-text prompt, the current composer draft, and the action.</summary>
    public sealed record ComposeAssistRequest(string? Prompt, string? CurrentDraft, string? Action);

    /// <summary>
    /// Load the chat context the AI features summarise/reply from: the channel display name (for context only)
    /// plus the newest <see cref="ChatAiContextSize"/> non-deleted messages as (display NAME, body) pairs —
    /// NEVER an email (email-privacy). Soft-deleted messages (null body) are excluded. Returns the messages
    /// both oldest-first (for the model, so the conversation reads in order) and newest-first names (for the
    /// deterministic plain floor "N messages from A, B and C.").
    /// </summary>
    private static async Task<(string? channelName,
        IReadOnlyList<(string name, string body)> oldestFirst,
        IReadOnlyList<string> namesNewestFirst)> LoadChatContextAsync(
        UsageDbContext db, int channelId, CancellationToken ct)
    {
        var channelName = await db.ChatChannels.AsNoTracking()
            .Where(c => c.Id == channelId).Select(c => c.Name).FirstOrDefaultAsync(ct);

        // Newest ChatAiContextSize, non-deleted only (body non-null). DTO build is the same email-privacy path
        // used everywhere: the sender is resolved to an AppUser display NAME, never the raw email.
        var rows = await db.ChatMessages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.DeletedUtc == null && m.Body != null)
            .OrderByDescending(m => m.Id)
            .Take(ChatAiContextSize)
            .Select(m => new { m.SenderEmail, m.Body })
            .ToListAsync(ct);

        var senders = await SenderLookupAsync(db, rows.Select(r => r.SenderEmail), ct);
        string NameFor(string email) => senders.GetValueOrDefault(email, UnknownSender).Name;

        // rows are newest-first; the model wants oldest-first so the conversation flows naturally.
        var oldestFirst = rows
            .AsEnumerable().Reverse()
            .Select(r => (name: NameFor(r.SenderEmail), body: r.Body ?? ""))
            .Where(x => x.body.Length > 0)
            .ToList();

        var namesNewestFirst = rows.Select(r => NameFor(r.SenderEmail)).ToList();

        return (channelName, oldestFirst, namesNewestFirst);
    }

    /// <summary>
    /// The deterministic plain floor for "catch me up" when Gemini is off/failed: "N messages from A, B and
    /// C." built from the newest names only (distinct, in most-recent order, at most three named). Always a
    /// sensible non-empty string so the endpoint can return 200 without ever calling the model.
    /// </summary>
    private static string PlainCatchUp(IReadOnlyList<string> namesNewestFirst)
    {
        var count = namesNewestFirst.Count;
        if (count == 0) return "Here's what you missed: no new messages.";

        var distinct = new List<string>();
        foreach (var n in namesNewestFirst)
        {
            var name = string.IsNullOrWhiteSpace(n) ? "Unknown user" : n.Trim();
            if (!distinct.Contains(name)) distinct.Add(name);
            if (distinct.Count >= 3) break;
        }

        var who = distinct.Count switch
        {
            1 => distinct[0],
            2 => $"{distinct[0]} and {distinct[1]}",
            _ => $"{distinct[0]}, {distinct[1]} and {distinct[2]}",
        };
        var msgWord = count == 1 ? "message" : "messages";
        return $"Here's what you missed: {count} {msgWord} from {who}.";
    }

    /// <summary>503 (never 500) when a chat-AI feature can't run — Gemini unconfigured or the call failed.</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "Chat AI is not available.",
        detail: "Chat AI is not available right now. You can do this manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
