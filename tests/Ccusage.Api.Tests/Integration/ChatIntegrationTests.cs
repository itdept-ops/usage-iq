using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.Http.Connections;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// In-app chat + inbox (Phase 1b): channel send/read by members, non-member 404/403 isolation,
/// DM get-or-create idempotency, soft-delete body hiding, edit/moderation, and notification
/// preference defaults + round-trip. Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ChatIntegrationTests(WebAppFactory factory)
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
        var email = $"chat-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Create a channel as a chat.send user, with the given member emails.</summary>
    private static async Task<int> CreateChannel(HttpClient owner, string name, params string[] memberEmails)
    {
        var resp = await owner.PostAsJsonAsync("/api/chat/channels",
            new { name, topic = (string?)null, isPrivate = false, memberEmails });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(resp)).GetProperty("id").GetInt32();
    }

    // ---- Permission gating ----

    [Fact]
    public async Task Chat_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/chat/channels")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/inbox")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Reading_requires_chat_read_and_sending_requires_chat_send()
    {
        var (_, noChat) = await ProvisionUser("dashboard.view");
        (await noChat.GetAsync("/api/chat/channels")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noChat.GetAsync("/api/inbox")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // chat.read alone can list but cannot create a channel (needs chat.send).
        var (_, readOnly) = await ProvisionUser("chat.read");
        (await readOnly.GetAsync("/api/chat/channels")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await readOnly.PostAsJsonAsync("/api/chat/channels",
                new { name = "x", isPrivate = false, memberEmails = Array.Empty<string>() }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Send + read within a channel ----

    [Fact]
    public async Task Member_can_send_and_read_messages_in_a_channel()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        var channelId = await CreateChannel(alice, "general-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hello team", mentionedEmails = (string[]?)null });
        send.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(send)).GetProperty("body").GetString().Should().Be("hello team");

        // Bob (a member) reads the history and sees the message.
        var hist = await bob.GetAsync($"/api/chat/channels/{channelId}/messages");
        hist.StatusCode.Should().Be(HttpStatusCode.OK);
        var msgs = (await Json(hist)).EnumerateArray().ToList();
        msgs.Should().ContainSingle();
        msgs[0].GetProperty("body").GetString().Should().Be("hello team");
        msgs[0].GetProperty("deleted").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Created_channel_appears_in_creators_channel_list()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var name = "list-me-" + Guid.NewGuid().ToString("N")[..6];
        var channelId = await CreateChannel(alice, name);

        var list = (await Json(await alice.GetAsync("/api/chat/channels"))).EnumerateArray().ToList();
        var mine = list.First(c => c.GetProperty("id").GetInt32() == channelId);
        mine.GetProperty("kind").GetString().Should().Be("channel");
        mine.GetProperty("displayName").GetString().Should().Be(name);
    }

    // ---- Non-member isolation ----

    [Fact]
    public async Task Non_member_cannot_read_or_send_to_a_channel()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (_, outsider) = await ProvisionUser("chat.read", "chat.send");

        var channelId = await CreateChannel(alice, "private-" + Guid.NewGuid().ToString("N")[..6]);

        // GET of a channel the caller isn't in returns 404 (never leak existence).
        (await outsider.GetAsync($"/api/chat/channels/{channelId}/messages"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // POST to that channel is likewise 404 for a non-member.
        (await outsider.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
                new { body = "let me in", mentionedEmails = (string[]?)null }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Direct messages: get-or-create idempotency ----

    [Fact]
    public async Task Opening_a_direct_returns_the_same_channel_for_the_same_pair()
    {
        var (aliceEmail, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        var first = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var firstJson = await Json(first);
        var firstId = firstJson.GetProperty("id").GetInt32();
        firstJson.GetProperty("kind").GetString().Should().Be("direct");

        // Alice opening again → same channel.
        var againJson = await Json(await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail }));
        againJson.GetProperty("id").GetInt32().Should().Be(firstId);

        // Bob opening from the other side → still the same channel (unordered pair).
        var fromBobJson = await Json(await bob.PostAsJsonAsync("/api/chat/direct", new { userEmail = aliceEmail }));
        fromBobJson.GetProperty("id").GetInt32().Should().Be(firstId);

        // The DM's display name for Alice is the OTHER member (Bob).
        againJson.GetProperty("displayName").GetString().Should().Be(bobEmail);
    }

    [Fact]
    public async Task Opening_a_direct_with_self_or_unknown_user_is_rejected()
    {
        var (selfEmail, me) = await ProvisionUser("chat.read", "chat.send");

        (await me.PostAsJsonAsync("/api/chat/direct", new { userEmail = selfEmail }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await me.PostAsJsonAsync("/api/chat/direct", new { userEmail = "ghost@nowhere.local" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Soft delete hides the body ----

    [Fact]
    public async Task Soft_deleted_message_hides_its_body_but_keeps_the_row()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "del-" + Guid.NewGuid().ToString("N")[..6]);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "secret words", mentionedEmails = (string[]?)null });
        var messageId = (await Json(send)).GetProperty("id").GetInt64();

        var del = await alice.DeleteAsync($"/api/chat/messages/{messageId}");
        del.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var hist = (await Json(await alice.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == messageId);
        hist.GetProperty("deleted").GetBoolean().Should().BeTrue();
        hist.TryGetProperty("body", out var body).Should().BeTrue();
        (body.ValueKind == JsonValueKind.Null).Should().BeTrue(); // body never leaks
    }

    // ---- Edit + moderation ----

    [Fact]
    public async Task Owner_can_edit_but_a_plain_member_cannot_edit_anothers_message()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "edit-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "typo heer", mentionedEmails = (string[]?)null });
        var messageId = (await Json(send)).GetProperty("id").GetInt64();

        // Owner edits → 200, EditedUtc set.
        var edit = await alice.PatchAsJsonAsync($"/api/chat/messages/{messageId}", new { body = "typo here" });
        edit.StatusCode.Should().Be(HttpStatusCode.OK);
        var editJson = await Json(edit);
        editJson.GetProperty("body").GetString().Should().Be("typo here");
        editJson.GetProperty("editedUtc").ValueKind.Should().NotBe(JsonValueKind.Null);

        // Bob (member, not owner, no moderate) cannot edit Alice's message → 403.
        (await bob.PatchAsJsonAsync($"/api/chat/messages/{messageId}", new { body = "hijack" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Moderator_can_delete_another_members_message()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (modEmail, mod) = await ProvisionUser("chat.read", "chat.send", "chat.moderate");
        var channelId = await CreateChannel(alice, "mod-" + Guid.NewGuid().ToString("N")[..6], modEmail);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "moderate me", mentionedEmails = (string[]?)null });
        var messageId = (await Json(send)).GetProperty("id").GetInt64();

        (await mod.DeleteAsync($"/api/chat/messages/{messageId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var hist = (await Json(await alice.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == messageId);
        hist.GetProperty("deleted").GetBoolean().Should().BeTrue();
    }

    // ---- Unread + read cursor ----

    [Fact]
    public async Task Unread_count_reflects_others_messages_and_clears_on_read()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "unread-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        // Alice posts two messages; Bob's unread should become 2.
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "one" });
        var second = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "two" });
        var lastId = (await Json(second)).GetProperty("id").GetInt64();

        var bobChannels = (await Json(await bob.GetAsync("/api/chat/channels"))).EnumerateArray()
            .First(c => c.GetProperty("id").GetInt32() == channelId);
        bobChannels.GetProperty("unreadCount").GetInt32().Should().Be(2);

        // Bob marks read up to the last message → unread 0.
        var read = await bob.PostAsJsonAsync($"/api/chat/channels/{channelId}/read", new { messageId = lastId });
        read.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(read)).GetProperty("unreadCount").GetInt32().Should().Be(0);
    }

    // ---- Channel create: unknown members silently dropped ----

    [Fact]
    public async Task Create_channel_drops_unknown_member_emails_and_keeps_the_creator()
    {
        var (aliceEmail, alice) = await ProvisionUser("chat.read", "chat.send");
        var (realEmail, _) = await ProvisionUser("chat.read");

        var resp = await alice.PostAsJsonAsync("/api/chat/channels", new
        {
            name = "drop-" + Guid.NewGuid().ToString("N")[..6],
            isPrivate = false,
            memberEmails = new[] { realEmail, "nobody@void.local" },
        });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var members = (await Json(resp)).GetProperty("members").EnumerateArray()
            .Select(m => m.GetProperty("email").GetString()).ToList();
        members.Should().Contain(aliceEmail);
        members.Should().Contain(realEmail);
        members.Should().NotContain("nobody@void.local");
    }

    // ---- Archive (moderation) ----

    [Fact]
    public async Task Archiving_a_channel_requires_moderate_and_removes_it_from_active_lists()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (_, mod) = await ProvisionUser("chat.read", "chat.send", "chat.moderate");
        var channelId = await CreateChannel(alice, "arch-" + Guid.NewGuid().ToString("N")[..6]);

        // A non-moderator can't archive.
        (await alice.DeleteAsync($"/api/chat/channels/{channelId}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // A moderator can.
        (await mod.DeleteAsync($"/api/chat/channels/{channelId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        // The archived channel no longer shows in the creator's active list.
        var list = (await Json(await alice.GetAsync("/api/chat/channels"))).EnumerateArray()
            .Select(c => c.GetProperty("id").GetInt32());
        list.Should().NotContain(channelId);
    }

    // ---- DM triggers a direct-message notification for the recipient ----

    [Fact]
    public async Task Direct_message_creates_a_notification_for_the_recipient()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "hi bob" });

        // Bob's inbox gets a directMessage notification (NotifyDirectMessages defaults to true).
        var inbox = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray().ToList();
        inbox.Should().Contain(n => n.GetProperty("type").GetString() == "directMessage");

        var count = (await Json(await bob.GetAsync("/api/inbox/unread-count"))).GetProperty("count").GetInt32();
        count.Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task Mention_in_a_channel_notifies_the_mentioned_member()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "mention-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hey @bob look", mentionedEmails = new[] { bobEmail } });

        var inbox = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray().ToList();
        inbox.Should().Contain(n => n.GetProperty("type").GetString() == "mention");
    }

    // ---- Inbox read / read-all ----

    [Fact]
    public async Task Marking_notifications_read_only_touches_the_callers_own_and_updates_count()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "ping" });

        var notifId = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray()
            .First().GetProperty("id").GetInt64();

        var read = await bob.PostAsJsonAsync("/api/inbox/read", new { ids = new[] { notifId } });
        read.StatusCode.Should().Be(HttpStatusCode.OK);

        // Alice can't mark Bob's notification (it's not in her inbox) — her read is a no-op.
        var aliceRead = await alice.PostAsJsonAsync("/api/inbox/read", new { ids = new[] { notifId } });
        aliceRead.StatusCode.Should().Be(HttpStatusCode.OK);

        // Bob's notification is read; the row still exists for Bob.
        var bobInbox = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray()
            .First(n => n.GetProperty("id").GetInt64() == notifId);
        bobInbox.GetProperty("isRead").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Read_all_clears_the_unread_count()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "a" });
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "b" });

        var readAll = await bob.PostAsync("/api/inbox/read-all", null);
        readAll.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(readAll)).GetProperty("unreadCount").GetInt32().Should().Be(0);
        (await Json(await bob.GetAsync("/api/inbox/unread-count"))).GetProperty("count").GetInt32().Should().Be(0);
    }

    // ---- Notification preferences: defaults + round-trip ----

    [Fact]
    public async Task Notification_preferences_default_then_round_trip_on_update()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");

        var defaults = await Json(await alice.GetAsync("/api/inbox/preferences"));
        defaults.GetProperty("notifyDirectMessages").GetBoolean().Should().BeTrue();
        defaults.GetProperty("notifyMentions").GetBoolean().Should().BeTrue();
        defaults.GetProperty("notifyChannelMessages").GetBoolean().Should().BeFalse();
        defaults.GetProperty("notifySystemEvents").GetBoolean().Should().BeTrue();
        defaults.GetProperty("surfaceToasts").GetBoolean().Should().BeTrue();
        defaults.GetProperty("surfaceBrowser").GetBoolean().Should().BeFalse();

        var updated = await alice.PutAsJsonAsync("/api/inbox/preferences", new
        {
            notifyDirectMessages = false,
            notifyMentions = true,
            notifyChannelMessages = true,
            notifySystemEvents = false,
            surfaceToasts = false,
            surfaceBrowser = true,
        });
        updated.StatusCode.Should().Be(HttpStatusCode.OK);

        var after = await Json(await alice.GetAsync("/api/inbox/preferences"));
        after.GetProperty("notifyDirectMessages").GetBoolean().Should().BeFalse();
        after.GetProperty("notifyChannelMessages").GetBoolean().Should().BeTrue();
        after.GetProperty("notifySystemEvents").GetBoolean().Should().BeFalse();
        after.GetProperty("surfaceToasts").GetBoolean().Should().BeFalse();
        after.GetProperty("surfaceBrowser").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Disabling_direct_message_notifications_suppresses_the_notification()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        // Bob turns OFF direct-message notifications.
        await bob.PutAsJsonAsync("/api/inbox/preferences", new
        {
            notifyDirectMessages = false,
            notifyMentions = true,
            notifyChannelMessages = false,
            notifySystemEvents = true,
            surfaceToasts = true,
            surfaceBrowser = false,
        });

        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "quiet" });

        (await Json(await bob.GetAsync("/api/inbox/unread-count"))).GetProperty("count").GetInt32().Should().Be(0);
    }

    // ---- FIX 1: DM get-or-create is concurrency-safe and de-duplicated ----

    [Fact]
    public async Task Concurrent_get_or_create_direct_returns_one_channel_and_no_duplicates()
    {
        var (aliceEmail, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        // Fire both sides at once: the partial unique index on DirectKey must collapse this to ONE row.
        var fromAlice = alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var fromBob = bob.PostAsJsonAsync("/api/chat/direct", new { userEmail = aliceEmail });
        await Task.WhenAll(fromAlice, fromBob);

        var aId = (await Json(await fromAlice)).GetProperty("id").GetInt32();
        var bId = (await Json(await fromBob)).GetProperty("id").GetInt32();
        (await fromAlice).StatusCode.Should().Be(HttpStatusCode.OK);
        (await fromBob).StatusCode.Should().Be(HttpStatusCode.OK);
        aId.Should().Be(bId); // same channel for the unordered pair

        // Exactly one Direct channel exists between them (each lists it once).
        var aliceDirects = (await Json(await alice.GetAsync("/api/chat/channels"))).EnumerateArray()
            .Count(c => c.GetProperty("kind").GetString() == "direct" && c.GetProperty("id").GetInt32() == aId);
        aliceDirects.Should().Be(1);
        var bobDirects = (await Json(await bob.GetAsync("/api/chat/channels"))).EnumerateArray()
            .Count(c => c.GetProperty("kind").GetString() == "direct" && c.GetProperty("id").GetInt32() == aId);
        bobDirects.Should().Be(1);
    }

    // ---- FIX 4: a read cursor for a message from a DIFFERENT channel is ignored ----

    [Fact]
    public async Task Read_cursor_with_a_message_id_from_another_channel_does_not_change_unread()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");
        var target = await CreateChannel(alice, "target-" + Guid.NewGuid().ToString("N")[..6], bobEmail);
        var other = await CreateChannel(alice, "other-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        // One unread message in the target channel for Bob.
        await alice.PostAsJsonAsync($"/api/chat/channels/{target}/messages", new { body = "unread" });
        // A message in the OTHER channel whose id is higher than anything in target.
        var foreign = await alice.PostAsJsonAsync($"/api/chat/channels/{other}/messages", new { body = "elsewhere" });
        var foreignId = (await Json(foreign)).GetProperty("id").GetInt64();

        // Bob tries to mark the target channel read using a message id that belongs to the OTHER channel.
        var read = await bob.PostAsJsonAsync($"/api/chat/channels/{target}/read", new { messageId = foreignId });
        read.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(read)).GetProperty("unreadCount").GetInt32().Should().Be(1); // unchanged: foreign id ignored

        var bobTarget = (await Json(await bob.GetAsync("/api/chat/channels"))).EnumerateArray()
            .First(c => c.GetProperty("id").GetInt32() == target);
        bobTarget.GetProperty("unreadCount").GetInt32().Should().Be(1);
    }

    // ---- FIX 3 + FIX 2: live JoinChannel membership, and distinct per-channel vs inbox events ----

    [Fact]
    public async Task JoinChannel_makes_a_new_members_group_membership_effective_for_live_broadcasts()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        // Bob connects to the hub BEFORE any shared channel exists.
        await using var bobHub = await ConnectHub(bobEmail);
        var received = new List<JsonElement>();
        var gate = new TaskCompletionSource();
        bobHub.On<JsonElement>("ReceiveMessage", m => { lock (received) received.Add(m); gate.TrySetResult(); });

        // Alice creates a channel that includes Bob (created mid-session, after Bob connected).
        var channelId = await CreateChannel(alice, "live-" + Guid.NewGuid().ToString("N")[..6], bobEmail);

        // Bob acts on ChannelAdded by joining the live group; now membership is effective.
        await bobHub.InvokeAsync("JoinChannel", channelId);

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "live hello" });

        await gate.Task.WaitAsync(TimeSpan.FromSeconds(10));
        lock (received)
        {
            received.Should().ContainSingle();
            received[0].GetProperty("body").GetString().Should().Be("live hello");
            received[0].GetProperty("channelId").GetInt32().Should().Be(channelId);
        }
    }

    [Fact]
    public async Task JoinChannel_is_a_no_op_for_a_non_member()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (outsiderEmail, _) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "closed-" + Guid.NewGuid().ToString("N")[..6]);

        await using var outsiderHub = await ConnectHub(outsiderEmail);
        var got = new TaskCompletionSource();
        outsiderHub.On<JsonElement>("ReceiveMessage", _ => got.TrySetResult());

        // The outsider tries to join a channel they're not a member of — must be a no-op (no throw).
        await outsiderHub.InvokeAsync("JoinChannel", channelId);
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "members only" });

        // The outsider must NOT receive the broadcast (join was rejected).
        var delivered = await Task.WhenAny(got.Task, Task.Delay(TimeSpan.FromSeconds(2)));
        (delivered == got.Task).Should().BeFalse();
    }

    [Fact]
    public async Task Per_channel_UnreadChanged_message_count_and_inbox_total_are_distinct_events()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob) = await ProvisionUser("chat.read", "chat.send");

        // A DM (so Bob gets a directMessage notification by default) — exercises both events at once.
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userEmail = bobEmail });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();

        await using var bobHub = await ConnectHub(bobEmail);
        await bobHub.InvokeAsync("JoinChannel", channelId);

        var unreadChanged = new List<(int channelId, int count)>();
        var inboxChanged = new List<int>();
        var unreadGate = new TaskCompletionSource();
        var inboxGate = new TaskCompletionSource();
        bobHub.On<int, int>("UnreadChanged", (cid, count) =>
        {
            lock (unreadChanged) unreadChanged.Add((cid, count));
            unreadGate.TrySetResult();
        });
        bobHub.On<int>("InboxUnreadChanged", total =>
        {
            lock (inboxChanged) inboxChanged.Add(total);
            inboxGate.TrySetResult();
        });

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "ping bob" });

        await Task.WhenAll(unreadGate.Task, inboxGate.Task).WaitAsync(TimeSpan.FromSeconds(10));

        lock (unreadChanged)
        {
            // UnreadChanged carries the per-channel MESSAGE count for THIS channel (one new message).
            unreadChanged.Should().Contain(x => x.channelId == channelId && x.count == 1);
        }
        lock (inboxChanged)
        {
            // InboxUnreadChanged carries the global unread NOTIFICATION total (at least the one DM).
            inboxChanged.Should().Contain(t => t >= 1);
        }
    }

    /// <summary>
    /// Build and start a real SignalR client connected to the in-memory test server (LongPolling,
    /// since the TestServer has no WebSocket). The JWT rides the ?access_token query param the hub
    /// auth reads, and the handler is the TestServer's so requests stay in-process.
    /// </summary>
    private async Task<HubConnection> ConnectHub(string email)
    {
        var server = factory.Server;
        var conn = new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, "api/hubs/chat"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.AccessTokenProvider = () => Task.FromResult<string?>(TestJwt.For(email));
            })
            .Build();
        await conn.StartAsync();
        return conn;
    }
}
