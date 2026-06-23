using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Hubs;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Hardening regression for chatnotif-n1: <see cref="ChatNotificationService"/> used to run one
/// <c>COUNT(*) WHERE RecipientEmail = email AND !IsRead</c> per recipient inside the fan-out loop (N+1).
/// That was replaced by a SINGLE grouped query materialized into a per-recipient dictionary. This test
/// pins the BEHAVIOUR the refactor must preserve: every recipient's emitted <c>InboxUnreadChanged</c>
/// payload equals their true unread total — including a recipient who carries extra pre-existing unread
/// rows (so a per-recipient grouping, not a shared count) and a recipient whose only unread row is the
/// one just created. Driven through the public <see cref="ChatNotificationService.NotifyFamily"/> path,
/// which fans out with no preference gating, so every targeted member is notified deterministically.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class Hardening_ChatNotificationInboxCount(WebAppFactory factory)
{
    /// <summary>Records every InboxUnreadChanged(count) pushed to a specific SignalR user id.</summary>
    private sealed class CapturingHub : IHubContext<ChatHub>
    {
        public readonly Dictionary<string, int> LastInboxUnread = new(StringComparer.Ordinal);
        public IHubClients Clients { get; }
        public IGroupManager Groups { get; } = new NoopGroups();

        public CapturingHub() => Clients = new Hubs_(this);

        private sealed class Hubs_(CapturingHub owner) : IHubClients
        {
            public IClientProxy All => new Noop();
            public IClientProxy AllExcept(IReadOnlyList<string> e) => new Noop();
            public IClientProxy Client(string connectionId) => new Noop();
            public IClientProxy Clients(IReadOnlyList<string> c) => new Noop();
            public IClientProxy Group(string groupName) => new Noop();
            public IClientProxy GroupExcept(string g, IReadOnlyList<string> e) => new Noop();
            public IClientProxy Groups(IReadOnlyList<string> g) => new Noop();
            public IClientProxy User(string userId) => new UserProxy(owner, userId);
            public IClientProxy Users(IReadOnlyList<string> u) => new Noop();
        }

        private sealed class UserProxy(CapturingHub owner, string userId) : IClientProxy
        {
            public Task SendCoreAsync(string method, object?[] args, CancellationToken ct = default)
            {
                if (method == "InboxUnreadChanged" && args.Length == 1 && args[0] is int count)
                    owner.LastInboxUnread[userId] = count;
                return Task.CompletedTask;
            }
        }

        private sealed class Noop : IClientProxy
        {
            public Task SendCoreAsync(string method, object?[] args, CancellationToken ct = default)
                => Task.CompletedTask;
        }

        private sealed class NoopGroups : IGroupManager
        {
            public Task AddToGroupAsync(string c, string g, CancellationToken ct = default) => Task.CompletedTask;
            public Task RemoveFromGroupAsync(string c, string g, CancellationToken ct = default) => Task.CompletedTask;
        }
    }

    private async Task<(string email, int id)> ProvisionUser()
    {
        var email = $"n1-{Guid.NewGuid():N}@test.local";
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var user = new AppUser { Email = email, Name = "N1 User", IsEnabled = true };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return (email, user.Id);
    }

    private async Task SeedUnread(string email, int count)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        for (var i = 0; i < count; i++)
        {
            db.Notifications.Add(new Notification
            {
                RecipientEmail = email.ToLowerInvariant(),
                Type = NotificationType.ChannelMessage,
                Text = "seed",
                IsRead = false,
                CreatedUtc = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task NotifyFamily_emits_each_recipients_true_unread_total_via_single_grouped_query()
    {
        // Recipient A starts with 2 pre-existing unread rows; recipient B starts with none. After the
        // fan-out writes one new row each, the per-recipient totals MUST differ (3 vs 1) — a shared or
        // mis-keyed count would surface here.
        var (emailA, idA) = await ProvisionUser();
        var (emailB, idB) = await ProvisionUser();
        await SeedUnread(emailA, 2);

        var hub = new CapturingHub();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var discord = scope.ServiceProvider.GetRequiredService<DiscordForwarder>();
        var svc = new ChatNotificationService(db, hub, discord);

        var written = await svc.NotifyFamily(
            new[] { idA, idB }, NotificationType.FamilyReminder, "Trash night", "/family");

        written.Should().Be(2, "one inbox row per resolved recipient");
        hub.LastInboxUnread[emailA.ToLowerInvariant()].Should().Be(3, "2 pre-existing + 1 new");
        hub.LastInboxUnread[emailB.ToLowerInvariant()].Should().Be(1, "only the freshly created row");

        // The emitted totals match the persisted truth (the grouped query is the source for both).
        using var verifyScope = factory.Services.CreateScope();
        var verifyDb = verifyScope.ServiceProvider.GetRequiredService<UsageDbContext>();
        (await verifyDb.Notifications.CountAsync(n => n.RecipientEmail == emailA.ToLowerInvariant() && !n.IsRead))
            .Should().Be(3);
        (await verifyDb.Notifications.CountAsync(n => n.RecipientEmail == emailB.ToLowerInvariant() && !n.IsRead))
            .Should().Be(1);
    }
}
