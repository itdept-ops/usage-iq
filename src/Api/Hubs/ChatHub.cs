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

    /// <summary>Persist + broadcast + fan out a message — the hub mirror of the REST send endpoint.</summary>
    public async Task SendMessage(int channelId, string body, string[]? mentionedEmails)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) throw new HubException("Not authenticated.");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var fanout = scope.ServiceProvider.GetRequiredService<ChatNotificationService>();

        if (!await HasSendAsync(scope, email)) throw new HubException("You don't have permission to send messages.");

        var channel = await db.ChatChannels.Include(c => c.Members)
            .FirstOrDefaultAsync(c => c.Id == channelId, Context.ConnectionAborted);
        if (channel is null || channel.Members.All(m => m.UserEmail != email))
            throw new HubException("You are not a member of that channel.");
        if (channel.ArchivedUtc is not null) throw new HubException("This channel is archived.");

        var text = (body ?? "").Trim();
        if (text.Length == 0) throw new HubException("Message body is required.");
        if (text.Length > 4000) text = text[..4000];

        var msg = new ChatMessage
        {
            ChannelId = channelId, SenderEmail = email, Body = text, CreatedUtc = DateTime.UtcNow,
        };
        db.ChatMessages.Add(msg);
        await db.SaveChangesAsync(Context.ConnectionAborted);

        var (name, pic) = await SenderInfoAsync(db, email);
        await fanout.FanOutMessageAsync(
            channel, msg, name, pic, mentionedEmails ?? Array.Empty<string>(), Context.ConnectionAborted);
    }

    public async Task StartTyping(int channelId) => await BroadcastTyping(channelId, true);

    public async Task StopTyping(int channelId) => await BroadcastTyping(channelId, false);

    private async Task BroadcastTyping(int channelId, bool isTyping)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) return;

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        if (!await HasReadAsync(scope, email)) return;
        if (!await ChatEndpoints.IsMemberAsync(db, channelId, email, Context.ConnectionAborted)) return;

        var (name, _) = await SenderInfoAsync(db, email);
        await Clients.OthersInGroup(ChatNotificationService.GroupFor(channelId))
            .SendAsync("TypingChanged", channelId, email, name, isTyping, Context.ConnectionAborted);
    }

    /// <summary>Advance the caller's read cursor and push their fresh unread count for the channel.</summary>
    public async Task MarkRead(int channelId, long messageId)
    {
        var email = Email;
        if (string.IsNullOrEmpty(email)) throw new HubException("Not authenticated.");

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        if (!await HasReadAsync(scope, email)) throw new HubException("You don't have permission to read chat.");

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
        if (!await HasReadAsync(scope, email)) return;
        if (!await ChatEndpoints.IsMemberAsync(db, channelId, email, Context.ConnectionAborted)) return;

        await Groups.AddToGroupAsync(Context.ConnectionId, ChatNotificationService.GroupFor(channelId), Context.ConnectionAborted);
    }

    // ---- per-call permission checks (DB-backed, mirroring PermissionFilter) ----

    private static async Task<bool> HasReadAsync(AsyncServiceScope scope, string email) =>
        await HasPermissionAsync(scope, email, Permissions.ChatRead);

    private static async Task<bool> HasSendAsync(AsyncServiceScope scope, string email) =>
        await HasPermissionAsync(scope, email, Permissions.ChatSend);

    private static async Task<bool> HasPermissionAsync(AsyncServiceScope scope, string email, string permission)
    {
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking()
            .Where(u => u.Email == email && u.IsEnabled)
            .AnyAsync(u => u.Permissions.Any(p => p.Permission == permission));
    }

    private static async Task<(string Name, string? Picture)> SenderInfoAsync(UsageDbContext db, string email)
    {
        var u = await db.Users.AsNoTracking()
            .Where(x => x.Email == email)
            .Select(x => new { x.Name, x.Picture })
            .FirstOrDefaultAsync();
        return u is null ? (email, null) : (string.IsNullOrEmpty(u.Name) ? email : u.Name, u.Picture);
    }
}
