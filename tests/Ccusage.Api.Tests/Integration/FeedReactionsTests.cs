using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Cheers/Kudos reactions on the social feed (<c>POST /api/feed/{id}/react</c> + the feed-DTO
/// <c>clapCount</c>/<c>iReacted</c> additions):
/// <list type="bullet">
///   <item>Toggle: a first react adds (reacted:true, count 1); a second removes (reacted:false, count 0).</item>
///   <item>Dedup: exactly one row per (reactor, event) — the unique index + toggle enforce it.</item>
///   <item>Visibility: a caller can only react to an event they can SEE (own, or a sharing contact's when
///   they opted to view) — an out-of-circle / non-sharing / view-off event is 404 (existence never leaked).</item>
///   <item>Notification: the actor gets EXACTLY ONE in-app cheer notification on a fresh cheer of someone
///   else's event — and NONE on a self-cheer or a toggle-off.</item>
///   <item>Privacy: the notification names the reactor by DisplayName only — never an email.</item>
///   <item>Count accuracy: clapCount in the feed DTO reflects all reactors; iReacted is the caller's own.</item>
/// </list>
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FeedReactionsTests(WebAppFactory factory)
{
    private HttpClient Admin()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        return c;
    }

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"react-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }

    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task SetActivityPrefs(string email, bool share, bool view)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.ShareActivity = share;
        u.ViewActivityFeed = view;
        await db.SaveChangesAsync();
    }

    /// <summary>Insert an event for an actor directly and return its id.</summary>
    private async Task<long> SeedEvent(string actorEmail, string kind = "workout.logged", int? intValue = 30, string? label = "Run")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var ev = new ActivityEvent
        {
            ActorEmail = actorEmail.ToLowerInvariant(), Kind = kind, IntValue = intValue, Label = label,
            CreatedUtc = DateTime.UtcNow,
        };
        db.ActivityEvents.Add(ev);
        await db.SaveChangesAsync();
        return ev.Id;
    }

    private async Task<List<Notification>> NotificationsFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.AsNoTracking()
            .Where(n => n.RecipientEmail == email).ToListAsync();
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    // ---- Toggle + dedup ----

    [Fact]
    public async Task React_toggles_add_then_remove_with_accurate_count()
    {
        var (email, client) = await ProvisionUser("tracker.self"); // own event is always visible
        var eventId = await SeedEvent(email);

        // First react: add.
        var add = await Json(await client.PostAsync($"/api/feed/{eventId}/react", null));
        add.GetProperty("iReacted").GetBoolean().Should().BeTrue();
        add.GetProperty("clapCount").GetInt32().Should().Be(1);

        // Second react: remove (toggle off).
        var remove = await Json(await client.PostAsync($"/api/feed/{eventId}/react", null));
        remove.GetProperty("iReacted").GetBoolean().Should().BeFalse();
        remove.GetProperty("clapCount").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task React_is_deduped_to_one_row_per_user_event()
    {
        var (email, client) = await ProvisionUser("tracker.self");
        var eventId = await SeedEvent(email);

        await client.PostAsync($"/api/feed/{eventId}/react", null);
        // A second add would be a toggle-off; assert the table never holds two rows for the same pair across
        // an add → off → add cycle.
        await client.PostAsync($"/api/feed/{eventId}/react", null); // off
        await client.PostAsync($"/api/feed/{eventId}/react", null); // on again

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var rows = await db.ActivityReactions.AsNoTracking()
            .CountAsync(r => r.ReactorEmail == email && r.ActivityEventId == eventId);
        rows.Should().Be(1, "at most one cheer row per (reactor, event)");
    }

    [Fact]
    public async Task Feed_dto_reflects_clapCount_and_iReacted_per_caller()
    {
        var (viewerEmail, viewer) = await ProvisionUser("tracker.self");
        var (friendEmail, friend) = await ProvisionUser("tracker.self");
        await MakeContacts(viewerEmail, friendEmail);
        await SetActivityPrefs(friendEmail, share: true, view: true);
        await SetActivityPrefs(viewerEmail, share: true, view: true);
        await MakeContacts(friendEmail, viewerEmail); // so the friend can see the viewer's event too

        var eventId = await SeedEvent(friendEmail);

        // Both the viewer and the friend cheer the friend's event.
        await viewer.PostAsync($"/api/feed/{eventId}/react", null);
        await friend.PostAsync($"/api/feed/{eventId}/react", null);

        // Viewer's feed: count 2, iReacted true.
        var vItem = (await Json(await viewer.GetAsync("/api/feed"))).GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("id").GetInt64() == eventId);
        vItem.GetProperty("clapCount").GetInt32().Should().Be(2);
        vItem.GetProperty("iReacted").GetBoolean().Should().BeTrue();
    }

    // ---- Visibility ----

    [Fact]
    public async Task Cannot_react_to_a_strangers_event_404()
    {
        var (_, caller) = await ProvisionUser("tracker.self");
        var (strangerEmail, _) = await ProvisionUser("tracker.self");
        // No contact edge; stranger sharing on shouldn't matter.
        await SetActivityPrefs(strangerEmail, share: true, view: false);
        var eventId = await SeedEvent(strangerEmail);

        (await caller.PostAsync($"/api/feed/{eventId}/react", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound, "a non-contact's event is invisible — never reveal it exists");
    }

    [Fact]
    public async Task Cannot_react_to_a_contact_who_is_not_sharing_404()
    {
        var (viewerEmail, viewer) = await ProvisionUser("tracker.self");
        var (friendEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(viewerEmail, friendEmail);
        await SetActivityPrefs(friendEmail, share: false, view: false); // contact but NOT sharing
        await SetActivityPrefs(viewerEmail, share: false, view: true);
        var eventId = await SeedEvent(friendEmail);

        (await viewer.PostAsync($"/api/feed/{eventId}/react", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Cannot_react_to_a_circle_event_when_view_is_off_404()
    {
        var (viewerEmail, viewer) = await ProvisionUser("tracker.self");
        var (friendEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(viewerEmail, friendEmail);
        await SetActivityPrefs(friendEmail, share: true, view: false);
        await SetActivityPrefs(viewerEmail, share: false, view: false); // view OFF: only own events visible
        var eventId = await SeedEvent(friendEmail);

        (await viewer.PostAsync($"/api/feed/{eventId}/react", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Can_react_to_a_sharing_contacts_event_when_opted_to_view()
    {
        var (viewerEmail, viewer) = await ProvisionUser("tracker.self");
        var (friendEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(viewerEmail, friendEmail);
        await SetActivityPrefs(friendEmail, share: true, view: false);
        await SetActivityPrefs(viewerEmail, share: false, view: true);
        var eventId = await SeedEvent(friendEmail);

        var res = await Json(await viewer.PostAsync($"/api/feed/{eventId}/react", null));
        res.GetProperty("iReacted").GetBoolean().Should().BeTrue();
        res.GetProperty("clapCount").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task React_to_a_missing_event_404()
    {
        var (_, client) = await ProvisionUser("tracker.self");
        (await client.PostAsync("/api/feed/999999999/react", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task React_requires_tracker_self_permission()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.PostAsync("/api/feed/1/react", null))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Notifications ----

    [Fact]
    public async Task Fresh_cheer_of_anothers_event_creates_exactly_one_actor_notification_using_DisplayName()
    {
        var (reactorEmail, reactor) = await ProvisionUser("tracker.self");
        var (actorEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(reactorEmail, actorEmail);
        await SetActivityPrefs(actorEmail, share: true, view: false);
        await SetActivityPrefs(reactorEmail, share: false, view: true);

        // Give the reactor a deterministic display name.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var r = await db.Users.FirstAsync(u => u.Email == reactorEmail);
            r.Name = "Sam Rivers";
            r.DisplayNameMode = DisplayNameMode.FirstName;
            await db.SaveChangesAsync();
        }

        var eventId = await SeedEvent(actorEmail);
        (await reactor.PostAsync($"/api/feed/{eventId}/react", null)).StatusCode.Should().Be(HttpStatusCode.OK);

        var notes = await NotificationsFor(actorEmail);
        var cheers = notes.Where(n => n.Type == NotificationType.Cheer).ToList();
        cheers.Should().ContainSingle("exactly one cheer notification on a fresh cheer");
        var note = cheers[0];
        note.Text.Should().Be("Sam cheered your workout");        // DisplayName (FirstName mode) used
        note.Text.Should().NotContain("@");                        // never an email
        note.Text.Should().NotContain(reactorEmail);
        note.ActorName.Should().Be("Sam");
        note.ActorEmail.Should().Be(reactorEmail);                 // server-side key only; never serialized
        note.Link.Should().Be("/feed");
    }

    [Fact]
    public async Task Toggle_off_does_not_create_a_second_notification()
    {
        var (reactorEmail, reactor) = await ProvisionUser("tracker.self");
        var (actorEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(reactorEmail, actorEmail);
        await SetActivityPrefs(actorEmail, share: true, view: false);
        await SetActivityPrefs(reactorEmail, share: false, view: true);
        var eventId = await SeedEvent(actorEmail);

        await reactor.PostAsync($"/api/feed/{eventId}/react", null); // on (notifies)
        await reactor.PostAsync($"/api/feed/{eventId}/react", null); // off (must NOT notify)

        var cheers = (await NotificationsFor(actorEmail)).Count(n => n.Type == NotificationType.Cheer);
        cheers.Should().Be(1, "the un-cheer must not fire another notification");
    }

    [Fact]
    public async Task Self_cheer_creates_no_notification()
    {
        var (email, client) = await ProvisionUser("tracker.self");
        var eventId = await SeedEvent(email);

        (await client.PostAsync($"/api/feed/{eventId}/react", null)).StatusCode.Should().Be(HttpStatusCode.OK);

        var cheers = (await NotificationsFor(email)).Count(n => n.Type == NotificationType.Cheer);
        cheers.Should().Be(0, "cheering your own event must never notify yourself");
    }
}
