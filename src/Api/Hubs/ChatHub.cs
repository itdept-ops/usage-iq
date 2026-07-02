using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Hubs;

/// <summary>
/// Real-time chat transport. Identity is the JWT <c>email</c> claim (lower-cased); capability is the
/// chat.* permission set, re-checked against the DB on every call. The hub itself is a singleton-per-
/// invocation, so scoped services (DbContext, fan-out, current-user accessor) are resolved through a
/// fresh <see cref="IServiceScopeFactory"/> scope inside each method — never injected directly.
///
/// On connect the caller is added to a <c>channel:{id}</c> group for every channel they belong to;
/// per-user pushes (notifications) use <c>Clients.User(email)</c> via <see cref="EmailUserIdProvider"/>.
/// </summary>
[Authorize]
public sealed class ChatHub(IServiceScopeFactory scopeFactory) : Hub
{
    private string? Email => Context.User?.FindFirst("email")?.Value?.Trim().ToLowerInvariant();

    /// <summary>The session stamp carried by this connection's bearer token (<c>sv</c> claim), mirroring
    /// the HTTP <c>OnTokenValidated</c> check. A missing/unparseable claim is treated as 0.</summary>
    private int TokenSv => int.TryParse(Context.User?.FindFirst("sv")?.Value, out var sv) ? sv : 0;

    public override async Task OnConnectedAsync()
    {
        var email = Email;
        await using var scope = scopeFactory.CreateAsyncScope();

        // No identity or no read capability ⇒ the connection has no business here.
        if (string.IsNullOrEmpty(email) || !await HasReadAsync(scope, email))
        {
            Context.Abort();
            return;
        }

        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var channelIds = await db.ChatChannelMembers.AsNoTracking()
            .Where(m => m.UserEmail == email)
            .Select(m => m.ChannelId)
            .ToListAsync(Context.ConnectionAborted);
        foreach (var id in channelIds)
            await Groups.AddToGroupAsync(Context.ConnectionId, ChatNotificationService.GroupFor(id));

        await base.OnConnectedAsync();
    }

    /// <summary>Persist + broadcast + fan out a message — the hub mirror of the REST send endpoint.
    /// Mentions are AppUser ids (email-privacy); the fan-out resolves them to emails server-side.</summary>
    public async Task SendMessage(int channelId, string body, int[]? mentionedUserIds)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) throw new HubException("Not authenticated.");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var fanout = scope.ServiceProvider.GetRequiredService<ChatNotificationService>();

        if (!await HasSendAsync(scope, email)) { Context.Abort(); throw new HubException("You don't have permission to send messages."); }

        var channel = await db.ChatChannels.Include(c => c.Members)
            .FirstOrDefaultAsync(c => c.Id == channelId, Context.ConnectionAborted);
        if (channel is null || channel.Members.All(m => m.UserEmail != email))
            throw new HubException("You are not a member of that channel.");
        if (channel.ArchivedUtc is not null) throw new HubException("This channel is archived.");

        // The mutual-contact gate is durable, not just enforced at first-DM creation: removing the
        // contact edge must cut off the existing DM too. Mirror the REST send endpoint — re-check it
        // on every Direct send. Chat admins (chat.contacts.manage) bypass, as there.
        if (channel.Kind == ChannelKind.Direct && !await HasContactsManageAsync(scope, email))
        {
            var other = channel.Members.FirstOrDefault(m => m.UserEmail != email)?.UserEmail;
            if (other is null || !await ContactGraph.IsContactAsync(db, email, other, Context.ConnectionAborted))
                throw new HubException("You can only message your contacts. Ask an admin to add them to your circle.");
        }

        var text = (body ?? "").Trim();
        if (text.Length == 0) throw new HubException("Message body is required.");
        if (text.Length > 4000) text = text[..4000];

        var msg = new ChatMessage
        {
            ChannelId = channelId, SenderEmail = email, Body = text, CreatedUtc = DateTime.UtcNow,
        };
        db.ChatMessages.Add(msg);
        await db.SaveChangesAsync(Context.ConnectionAborted);

        var sender = await SenderInfoAsync(db, email);
        await fanout.FanOutMessageAsync(
            channel, msg, sender, mentionedUserIds ?? Array.Empty<int>(), Context.ConnectionAborted);
    }

    /// <summary>Toggle the caller's emoji reaction on a message — the hub mirror of the REST reactions endpoint.</summary>
    public async Task ToggleReaction(long messageId, string emoji)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) throw new HubException("Not authenticated.");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var reactions = scope.ServiceProvider.GetRequiredService<ChatNotificationService>();

        if (!await HasSendAsync(scope, email)) { Context.Abort(); throw new HubException("You don't have permission to react."); }

        if (!ChatNotificationService.TryNormalizeEmoji(emoji, out var normalized, out var error))
            throw new HubException(error);

        var msg = await db.ChatMessages.AsNoTracking()
            .Where(m => m.Id == messageId)
            .Select(m => new { m.Id, m.ChannelId })
            .FirstOrDefaultAsync(Context.ConnectionAborted);
        if (msg is null || !await ChatEndpoints.IsMemberAsync(db, msg.ChannelId, email, Context.ConnectionAborted))
            throw new HubException("You are not a member of that channel.");

        await reactions.ToggleReactionAsync(msg.ChannelId, msg.Id, email, normalized, Context.ConnectionAborted);
    }

    public async Task StartTyping(int channelId) => await BroadcastTyping(channelId, true);

    public async Task StopTyping(int channelId) => await BroadcastTyping(channelId, false);

    private async Task BroadcastTyping(int channelId, bool isTyping)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) return;

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        if (!await HasReadAsync(scope, email)) { Context.Abort(); return; }
        if (!await ChatEndpoints.IsMemberAsync(db, channelId, email, Context.ConnectionAborted)) return;

        // TypingChanged carries the typist's AppUser id + name — never their email (email-privacy).
        var typist = await SenderInfoAsync(db, email);
        await Clients.OthersInGroup(ChatNotificationService.GroupFor(channelId))
            .SendAsync("TypingChanged", channelId, typist.Id, typist.Name, isTyping, Context.ConnectionAborted);
    }

    /// <summary>Advance the caller's read cursor and push their fresh unread count for the channel.</summary>
    public async Task MarkRead(int channelId, long messageId)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) throw new HubException("Not authenticated.");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        if (!await HasReadAsync(scope, email)) { Context.Abort(); throw new HubException("You don't have permission to read chat."); }

        var member = await db.ChatChannelMembers
            .FirstOrDefaultAsync(m => m.ChannelId == channelId && m.UserEmail == email, Context.ConnectionAborted);
        if (member is null) throw new HubException("You are not a member of that channel.");

        // Only ever advance, and only to a message that actually belongs to this channel.
        if (messageId > (member.LastReadMessageId ?? 0)
            && await db.ChatMessages.AsNoTracking()
                .AnyAsync(m => m.Id == messageId && m.ChannelId == channelId, Context.ConnectionAborted))
        {
            member.LastReadMessageId = messageId;
            await db.SaveChangesAsync(Context.ConnectionAborted);
        }
        var unread = await ChatEndpoints.UnreadCountAsync(db, channelId, member.LastReadMessageId, email, Context.ConnectionAborted);
        await Clients.User(email).SendAsync("UnreadChanged", channelId, unread, Context.ConnectionAborted);
    }

    /// <summary>
    /// Join the live broadcast group for a channel/DM the caller already belongs to. A client calls
    /// this when it receives <c>ChannelAdded</c> for a conversation created mid-session, so it starts
    /// receiving group broadcasts without reconnecting. A non-member (or no read capability) is a no-op.
    /// </summary>
    public async Task JoinChannel(int channelId)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) return;

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        if (!await HasReadAsync(scope, email)) { Context.Abort(); return; }
        if (!await ChatEndpoints.IsMemberAsync(db, channelId, email, Context.ConnectionAborted)) return;

        await Groups.AddToGroupAsync(Context.ConnectionId, ChatNotificationService.GroupFor(channelId), Context.ConnectionAborted);
    }

    // ---- per-call permission checks (DB-backed, mirroring PermissionFilter) ----

    private Task<bool> HasReadAsync(AsyncServiceScope scope, string email) =>
        HasPermissionAsync(scope, email, TokenSv, Permissions.ChatRead);

    private Task<bool> HasSendAsync(AsyncServiceScope scope, string email) =>
        HasPermissionAsync(scope, email, TokenSv, Permissions.ChatSend);

    private Task<bool> HasContactsManageAsync(AsyncServiceScope scope, string email) =>
        HasPermissionAsync(scope, email, TokenSv, Permissions.ChatContactsManage);

    /// <summary>
    /// Re-validates the caller for the LIFETIME of the hub connection — not just at handshake — mirroring
    /// the HTTP <c>OnTokenValidated</c> gate. Requires the account to be enabled, to still hold the chat
    /// permission, AND for the connection's token <c>sv</c> claim to still match the user's current
    /// <see cref="AppUser.SessionVersion"/>. An admin force-logout (sv bump), disable, or permission
    /// revocation therefore fails the next per-call check, so callers can tear the stale connection down.
    /// </summary>
    private static async Task<bool> HasPermissionAsync(AsyncServiceScope scope, string email, int tokenSv, string permission)
    {
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking()
            .Where(u => u.Email == email && u.IsEnabled && u.SessionVersion == tokenSv)
            .AnyAsync(u => u.Permissions.Any(p => p.Permission == permission));
    }

    private static async Task<ChatNotificationService.SenderIdentity> SenderInfoAsync(UsageDbContext db, string email)
    {
        var u = await db.Users.AsNoTracking()
            .Where(x => x.Email == email)
            .Select(x => new { x.Id, x.Name, x.DisplayNameMode, x.Nickname, x.Picture })
            .FirstOrDefaultAsync();
        return u is null
            ? new ChatNotificationService.SenderIdentity(0, "Unknown user", null)
            : new ChatNotificationService.SenderIdentity(u.Id, DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname), u.Picture);
    }
}
