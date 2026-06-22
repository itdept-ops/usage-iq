using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Temporary LIVE location share scoped to one chat conversation: the start/update/extend/stop + get-active
/// endpoints, the active/auto-expire logic, the gating (chat.send + location.self to mutate your OWN share;
/// chat.read to view; only conversations you belong to), and email-privacy on the wire. Every test provisions
/// fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ChatLocationShareTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"share-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<int> CreateChannel(HttpClient owner, params int[] memberUserIds)
    {
        var resp = await owner.PostAsJsonAsync("/api/chat/channels",
            new { name = "loc-" + Guid.NewGuid().ToString("N")[..6], isPrivate = false, memberUserIds });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(resp)).GetProperty("id").GetInt32();
    }

    /// <summary>The two perms required to start/mutate a share.</summary>
    private static readonly string[] SharerPerms = { "chat.read", "chat.send", "location.self" };

    private static Task<HttpResponseMessage> Start(HttpClient c, int channelId, object body) =>
        c.PostAsJsonAsync($"/api/chat/channels/{channelId}/location-share", body);

    private static async Task<JsonElement> StartOk(HttpClient c, int channelId, int? durationMinutes = null)
    {
        var res = await Start(c, channelId, new { lat = 27.9, lng = -82.4, durationMinutes });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return await Json(res);
    }

    // ---- Gating ----

    [Fact]
    public async Task Share_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/chat/channels/1/location-shares")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/chat/channels/1/location-share", new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Starting_requires_both_location_self_and_chat_send()
    {
        var (_, owner, ownerId) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);

        // chat.send but NO location.self -> 403.
        var (_, noLoc, noLocId) = await ProvisionUser("chat.read", "chat.send");
        await AddMember(channelId, noLocId);
        (await Start(noLoc, channelId, new { lat = 1.0, lng = 2.0 })).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // location.self but NO chat.send -> 403.
        var (_, noSend, noSendId) = await ProvisionUser("chat.read", "location.self");
        await AddMember(channelId, noSendId);
        (await Start(noSend, channelId, new { lat = 1.0, lng = 2.0 })).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Both -> 200.
        (await Start(owner, channelId, new { lat = 1.0, lng = 2.0 })).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Viewing_active_shares_requires_chat_read()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);

        var (_, noRead) = await ProvisionUserClient("dashboard.view");
        (await noRead.GetAsync($"/api/chat/channels/{channelId}/location-shares"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    private async Task<(string email, HttpClient client)> ProvisionUserClient(params string[] perms)
    {
        var (email, client, _) = await ProvisionUser(perms);
        return (email, client);
    }

    // ---- Default duration ----

    [Fact]
    public async Task Start_defaults_to_15_minutes()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);

        var dto = await StartOk(owner, channelId, durationMinutes: null);
        dto.GetProperty("active").GetBoolean().Should().BeTrue();
        dto.GetProperty("stopped").GetBoolean().Should().BeFalse();

        var start = dto.GetProperty("startUtc").GetDateTime();
        var expires = dto.GetProperty("expiresUtc").GetDateTime();
        (expires - start).TotalMinutes.Should().BeApproximately(15, 0.5);
    }

    // ---- Only a participant sees a conversation's shares ----

    [Fact]
    public async Task Only_a_participant_sees_a_conversations_shares()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var (_, member, memberId) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner, memberId);
        await StartOk(owner, channelId);

        // A member sees the active share.
        var memberView = await Json(await member.GetAsync($"/api/chat/channels/{channelId}/location-shares"));
        memberView.GetArrayLength().Should().Be(1);

        // A non-member gets 404 (existence never leaked) — not an empty list.
        var (_, outsider, _) = await ProvisionUser(SharerPerms);
        (await outsider.GetAsync($"/api/chat/channels/{channelId}/location-shares"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_non_participant_cannot_start_or_update_a_share()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);
        var started = await StartOk(owner, channelId);
        var shareId = started.GetProperty("id").GetInt32();

        var (_, outsider, _) = await ProvisionUser(SharerPerms);

        // Can't START into a channel they don't belong to (404, existence not leaked).
        (await Start(outsider, channelId, new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Can't UPDATE someone else's share (404 — not owned).
        (await outsider.PutAsJsonAsync($"/api/chat/location-share/{shareId}/position", new { lat = 5.0, lng = 6.0 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Can't STOP someone else's share either.
        (await outsider.PostAsJsonAsync($"/api/chat/location-share/{shareId}/stop", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Update ----

    [Fact]
    public async Task Sharer_can_update_position_on_an_active_share()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);
        var shareId = (await StartOk(owner, channelId)).GetProperty("id").GetInt32();

        var upd = await owner.PutAsJsonAsync($"/api/chat/location-share/{shareId}/position",
            new { lat = 40.0, lng = -73.0, accuracyM = 12.0 });
        upd.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(upd);
        dto.GetProperty("lat").GetDouble().Should().BeApproximately(40.0, 0.0001);
        dto.GetProperty("lng").GetDouble().Should().BeApproximately(-73.0, 0.0001);
        dto.GetProperty("accuracyM").GetDouble().Should().BeApproximately(12.0, 0.0001);
    }

    // ---- Extend pushes ExpiresUtc ----

    [Fact]
    public async Task Extend_pushes_expires_utc_further()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);
        var started = await StartOk(owner, channelId, durationMinutes: 15);
        var shareId = started.GetProperty("id").GetInt32();
        var before = started.GetProperty("expiresUtc").GetDateTime();

        var ext = await owner.PostAsJsonAsync($"/api/chat/location-share/{shareId}/extend", new { addMinutes = 60 });
        ext.StatusCode.Should().Be(HttpStatusCode.OK);
        var after = (await Json(ext)).GetProperty("expiresUtc").GetDateTime();

        (after - before).TotalMinutes.Should().BeApproximately(60, 0.5);
    }

    // ---- Stop ends it ----

    [Fact]
    public async Task Stop_ends_the_share()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var (_, member, memberId) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner, memberId);
        var shareId = (await StartOk(owner, channelId)).GetProperty("id").GetInt32();

        var stop = await owner.PostAsJsonAsync($"/api/chat/location-share/{shareId}/stop", new { });
        stop.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(stop);
        dto.GetProperty("stopped").GetBoolean().Should().BeTrue();
        dto.GetProperty("active").GetBoolean().Should().BeFalse();

        // A stopped share no longer appears in the conversation's active shares.
        var view = await Json(await member.GetAsync($"/api/chat/channels/{channelId}/location-shares"));
        view.GetArrayLength().Should().Be(0);

        // Updating a stopped share is rejected (no longer active).
        (await owner.PutAsJsonAsync($"/api/chat/location-share/{shareId}/position", new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Auto-expire: a past-expiry share reads as ended ----

    [Fact]
    public async Task An_expired_share_reads_as_ended_and_cannot_be_updated()
    {
        var (_, owner, _) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner);
        var shareId = (await StartOk(owner, channelId)).GetProperty("id").GetInt32();

        // Force the share's expiry into the past (server filters active by now < ExpiresUtc).
        await ExpireShare(shareId);

        // It no longer appears in the active-shares read (auto-expire; no row mutation needed).
        var view = await Json(await owner.GetAsync($"/api/chat/channels/{channelId}/location-shares"));
        view.GetArrayLength().Should().Be(0);

        // And it can't be updated or extended once expired.
        (await owner.PutAsJsonAsync($"/api/chat/location-share/{shareId}/position", new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await owner.PostAsJsonAsync($"/api/chat/location-share/{shareId}/extend", new { addMinutes = 15 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Email privacy ----

    [Fact]
    public async Task Share_payloads_carry_user_id_and_name_never_email()
    {
        var (ownerEmail, owner, ownerId) = await ProvisionUser(SharerPerms);
        var (_, member, memberId) = await ProvisionUser(SharerPerms);
        var channelId = await CreateChannel(owner, memberId);

        var started = await StartOk(owner, channelId);
        started.GetProperty("sharerUserId").GetInt32().Should().Be(ownerId);
        started.TryGetProperty("sharerEmail", out _).Should().BeFalse();

        var res = await member.GetAsync($"/api/chat/channels/{channelId}/location-shares");
        var raw = await res.Content.ReadAsStringAsync();
        // The sharer's email must NEVER appear on the wire (email-privacy).
        raw.Should().NotContain(ownerEmail);
        raw.Should().NotContain("@");
        (await Json(res))[0].GetProperty("sharerUserId").GetInt32().Should().Be(ownerId);
    }

    // ===== DB helpers (manipulate persisted state the API doesn't expose directly) =====

    /// <summary>Add a user (by AppUser id) to a channel directly, so non-owner-membership scenarios are
    /// testable without an "add member" endpoint.</summary>
    private async Task AddMember(int channelId, int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var email = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Email).FirstAsync();
        if (!await db.ChatChannelMembers.AnyAsync(m => m.ChannelId == channelId && m.UserEmail == email))
        {
            db.ChatChannelMembers.Add(new Ccusage.Api.Data.Entities.ChatChannelMember
            {
                ChannelId = channelId, UserEmail = email, JoinedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }
    }

    /// <summary>Force a share's ExpiresUtc into the past to exercise the auto-expire read filter.</summary>
    private async Task ExpireShare(int shareId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var share = await db.ChatLocationShares.FirstAsync(s => s.Id == shareId);
        share.ExpiresUtc = DateTime.UtcNow.AddMinutes(-1);
        await db.SaveChangesAsync();
    }
}
