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
        var (email, client, _) = await ProvisionUserWithId(permissions);
        return (email, client);
    }

    /// <summary>Like <see cref="ProvisionUser"/> but also returns the created AppUser id (from the
    /// create-user response) — for asserting server-resolved actor identity.</summary>
    private async Task<(string email, HttpClient client, int id)> ProvisionUserWithId(params string[] permissions)
    {
        var email = $"chat-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>True when the JSON object has a property with the given name. A plain method (not a
    /// lambda) so the <c>out</c> variable is legal — used inside FluentAssertions predicates where a
    /// discard in an expression tree would not compile.</summary>
    private static bool HasProperty(JsonElement el, string name)
    {
        return el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);
    }

    /// <summary>Make two users MUTUAL chat contacts via the admin contacts editor (chat.contacts.manage),
    /// so the DM contact-gate admits a DM between them. Idempotent.</summary>
    private async Task MakeContacts(int userIdA, int userIdB)
    {
        var (_, contactsAdmin, _) = await ProvisionUserWithId("chat.read", "chat.contacts.manage");
        var res = await contactsAdmin.PostAsJsonAsync(
            $"/api/chat/contacts/user/{userIdA}", new { contactUserId = userIdB });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>Create a channel as a chat.send user, with the given member AppUser ids (email-privacy:
    /// members are addressed by id, never email).</summary>
    private static async Task<int> CreateChannel(HttpClient owner, string name, params int[] memberUserIds)
    {
        var resp = await owner.PostAsJsonAsync("/api/chat/channels",
            new { name, topic = (string?)null, isPrivate = false, memberUserIds });
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
                new { name = "x", isPrivate = false, memberUserIds = Array.Empty<int>() }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Send + read within a channel ----

    [Fact]
    public async Task Member_can_send_and_read_messages_in_a_channel()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");

        var channelId = await CreateChannel(alice, "general-" + Guid.NewGuid().ToString("N")[..6], bobId);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hello team", mentionedUserIds = (int[]?)null });
        send.StatusCode.Should().Be(HttpStatusCode.OK);
        var sent = await Json(send);
        sent.GetProperty("body").GetString().Should().Be("hello team");
        // Email-privacy: the author is exposed as senderUserId (no senderEmail property at all).
        sent.TryGetProperty("senderEmail", out _).Should().BeFalse();
        sent.GetProperty("senderUserId").GetInt32().Should().Be(aliceId);

        // Bob (a member) reads the history and sees the message — by senderUserId, never an email.
        var hist = await bob.GetAsync($"/api/chat/channels/{channelId}/messages");
        hist.StatusCode.Should().Be(HttpStatusCode.OK);
        var msgs = (await Json(hist)).EnumerateArray().ToList();
        msgs.Should().ContainSingle();
        msgs[0].GetProperty("body").GetString().Should().Be("hello team");
        msgs[0].GetProperty("deleted").GetBoolean().Should().BeFalse();
        msgs[0].TryGetProperty("senderEmail", out _).Should().BeFalse();
        msgs[0].GetProperty("senderUserId").GetInt32().Should().Be(aliceId);

        // Bob derives "mine" by comparing senderUserId to his own /me userId — Alice's message is NOT his.
        var bobMe = await Json(await bob.GetAsync("/api/auth/me"));
        var bobUserId = bobMe.GetProperty("userId").GetInt32();
        (msgs[0].GetProperty("senderUserId").GetInt32() == bobUserId).Should().BeFalse();
    }

    [Fact]
    public async Task Me_returns_the_callers_user_id_for_self_derivation()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "self-" + Guid.NewGuid().ToString("N")[..6]);
        var messageId = await Send(alice, channelId, "this is mine");

        // /me carries the caller's own userId, matching the senderUserId of her own message ("mine").
        var me = await Json(await alice.GetAsync("/api/auth/me"));
        me.GetProperty("userId").GetInt32().Should().Be(aliceId);

        var msg = (await Json(await alice.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == messageId);
        (msg.GetProperty("senderUserId").GetInt32() == me.GetProperty("userId").GetInt32())
            .Should().BeTrue(); // "mine" derived by id, no email comparison
    }

    [Fact]
    public async Task Channel_list_members_and_last_message_carry_user_ids_not_emails()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "members-" + Guid.NewGuid().ToString("N")[..6], bobId);
        await Send(alice, channelId, "latest");

        var mine = (await Json(await alice.GetAsync("/api/chat/channels"))).EnumerateArray()
            .First(c => c.GetProperty("id").GetInt32() == channelId);

        // No member carries an email; members are addressed by userId.
        var members = mine.GetProperty("members").EnumerateArray().ToList();
        members.Should().OnlyContain(m => !HasProperty(m, "email"));
        var memberIds = members.Select(m => m.GetProperty("userId").GetInt32()).ToList();
        memberIds.Should().Contain(new[] { aliceId, bobId });

        // The embedded last message is likewise sender-by-id with no email.
        var last = mine.GetProperty("lastMessage");
        last.TryGetProperty("senderEmail", out _).Should().BeFalse();
        last.GetProperty("senderUserId").GetInt32().Should().Be(aliceId);

        // Belt-and-suspenders: nowhere in the channel-list payload is there an "@".
        mine.GetRawText().Should().NotContain("@");
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
                new { body = "let me in", mentionedUserIds = (int[]?)null }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Direct messages: get-or-create idempotency ----

    [Fact]
    public async Task Opening_a_direct_returns_the_same_channel_for_the_same_pair()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate: they must be mutual contacts

        // Open a DM by the other participant's AppUser id (email-privacy: no email on the wire).
        var first = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var firstJson = await Json(first);
        var firstId = firstJson.GetProperty("id").GetInt32();
        firstJson.GetProperty("kind").GetString().Should().Be("direct");

        // Alice opening again → same channel.
        var againJson = await Json(await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId }));
        againJson.GetProperty("id").GetInt32().Should().Be(firstId);

        // Bob opening from the other side → still the same channel (unordered pair).
        var fromBobJson = await Json(await bob.PostAsJsonAsync("/api/chat/direct", new { userId = aliceId }));
        fromBobJson.GetProperty("id").GetInt32().Should().Be(firstId);

        // The DM's display name for Alice is the OTHER member (Bob), by NAME — never his email.
        // These test users have no name, so it falls back to "Unknown user" (privacy: not the email).
        var dmName = againJson.GetProperty("displayName").GetString();
        dmName.Should().Be("Unknown user");
        dmName.Should().NotContain("@");
    }

    [Fact]
    public async Task Opening_a_direct_with_self_or_unknown_user_is_rejected()
    {
        var (selfEmail, me, selfId) = await ProvisionUserWithId("chat.read", "chat.send");

        // Opening a DM with yourself (by your own id) is rejected.
        (await me.PostAsJsonAsync("/api/chat/direct", new { userId = selfId }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // An unknown user id is rejected.
        (await me.PostAsJsonAsync("/api/chat/direct", new { userId = 99999999 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Soft delete hides the body ----

    [Fact]
    public async Task Soft_deleted_message_hides_its_body_but_keeps_the_row()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "del-" + Guid.NewGuid().ToString("N")[..6]);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "secret words", mentionedUserIds = (int[]?)null });
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
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "edit-" + Guid.NewGuid().ToString("N")[..6], bobId);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "typo heer", mentionedUserIds = (int[]?)null });
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
        var (modEmail, mod, modId) = await ProvisionUserWithId("chat.read", "chat.send", "chat.moderate");
        var channelId = await CreateChannel(alice, "mod-" + Guid.NewGuid().ToString("N")[..6], modId);

        var send = await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "moderate me", mentionedUserIds = (int[]?)null });
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
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "unread-" + Guid.NewGuid().ToString("N")[..6], bobId);

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
    public async Task Create_channel_drops_unknown_member_ids_and_keeps_the_creator()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (realEmail, _, realId) = await ProvisionUserWithId("chat.read");

        var resp = await alice.PostAsJsonAsync("/api/chat/channels", new
        {
            name = "drop-" + Guid.NewGuid().ToString("N")[..6],
            isPrivate = false,
            // A valid member id + an unknown id (no such user) — the unknown is silently dropped.
            memberUserIds = new[] { realId, 99999999 },
        });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        // Email-privacy: members carry userId (server-resolved), never an email. The creator + the valid
        // requested member are present by id; the unknown id is dropped.
        var members = (await Json(resp)).GetProperty("members").EnumerateArray().ToList();
        members.Should().OnlyContain(m => !HasProperty(m, "email")); // no email property at all
        var memberIds = members.Select(m => m.GetProperty("userId").GetInt32()).ToList();
        memberIds.Should().Contain(aliceId);
        memberIds.Should().Contain(realId);
        memberIds.Should().HaveCount(2); // only the two real users — the unknown id produced no member
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
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate

        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "hi bob" });

        // Bob's inbox gets a directMessage notification (NotifyDirectMessages defaults to true).
        var inbox = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray().ToList();
        var notif = inbox.Single(n => n.GetProperty("type").GetString() == "directMessage");

        // Email-privacy: the actor is exposed as ActorUserId + ActorName, never as an email. No "@" leaks in
        // the actor fields (and there is no actorEmail property at all).
        notif.TryGetProperty("actorEmail", out _).Should().BeFalse();
        notif.GetProperty("actorUserId").GetInt32().Should().Be(aliceId);
        var actorName = notif.GetProperty("actorName").GetString();
        actorName.Should().NotBeNullOrEmpty();
        actorName.Should().NotContain("@");

        var count = (await Json(await bob.GetAsync("/api/inbox/unread-count"))).GetProperty("count").GetInt32();
        count.Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task Mention_in_a_channel_notifies_the_mentioned_member()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "mention-" + Guid.NewGuid().ToString("N")[..6], bobId);

        // Mentions are sent by AppUser id (email-privacy); the server resolves id -> member email and
        // fires the dedicated "you were mentioned" notification for that member.
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hey @bob look", mentionedUserIds = new[] { bobId } });

        var inbox = (await Json(await bob.GetAsync("/api/inbox"))).EnumerateArray().ToList();
        var mention = inbox.Single(n => n.GetProperty("type").GetString() == "mention");
        // The actor (Alice) is exposed by id, never by email.
        mention.TryGetProperty("actorEmail", out _).Should().BeFalse();
        mention.GetProperty("actorUserId").GetInt32().Should().Be(aliceId);
    }

    [Fact]
    public async Task Mention_of_a_non_member_id_does_not_notify_anyone()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (_, outsider, outsiderId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "ment-out-" + Guid.NewGuid().ToString("N")[..6], bobId);

        // Mention an id that is NOT a member of the channel — they must NOT get a mention notification.
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hey @outsider", mentionedUserIds = new[] { outsiderId } });

        var outsiderInbox = (await Json(await outsider.GetAsync("/api/inbox"))).EnumerateArray().ToList();
        outsiderInbox.Should().NotContain(n => n.GetProperty("type").GetString() == "mention");
    }

    // ---- Inbox read / read-all ----

    [Fact]
    public async Task Marking_notifications_read_only_touches_the_callers_own_and_updates_count()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
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
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
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
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate

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

        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        var channelId = (await Json(dm)).GetProperty("id").GetInt32();
        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "quiet" });

        (await Json(await bob.GetAsync("/api/inbox/unread-count"))).GetProperty("count").GetInt32().Should().Be(0);
    }

    // ---- FIX 1: DM get-or-create is concurrency-safe and de-duplicated ----

    [Fact]
    public async Task Concurrent_get_or_create_direct_returns_one_channel_and_no_duplicates()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate

        // Fire both sides at once: the partial unique index on DirectKey must collapse this to ONE row.
        var fromAlice = alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        var fromBob = bob.PostAsJsonAsync("/api/chat/direct", new { userId = aliceId });
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
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var target = await CreateChannel(alice, "target-" + Guid.NewGuid().ToString("N")[..6], bobId);
        var other = await CreateChannel(alice, "other-" + Guid.NewGuid().ToString("N")[..6], bobId);

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
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");

        // Bob connects to the hub BEFORE any shared channel exists.
        await using var bobHub = await ConnectHub(bobEmail);
        var received = new List<JsonElement>();
        var gate = new TaskCompletionSource();
        bobHub.On<JsonElement>("ReceiveMessage", m => { lock (received) received.Add(m); gate.TrySetResult(); });

        // Alice creates a channel that includes Bob (created mid-session, after Bob connected).
        var channelId = await CreateChannel(alice, "live-" + Guid.NewGuid().ToString("N")[..6], bobId);

        // Bob acts on ChannelAdded by joining the live group; now membership is effective.
        await bobHub.InvokeAsync("JoinChannel", channelId);

        await alice.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages", new { body = "live hello" });

        await gate.Task.WaitAsync(TimeSpan.FromSeconds(10));
        lock (received)
        {
            received.Should().ContainSingle();
            received[0].GetProperty("body").GetString().Should().Be("live hello");
            received[0].GetProperty("channelId").GetInt32().Should().Be(channelId);
            // The realtime DTO is identical to REST: sender by userId, no email leak (email-privacy).
            received[0].TryGetProperty("senderEmail", out _).Should().BeFalse();
            received[0].GetProperty("senderUserId").GetInt32().Should().Be(aliceId);
        }
    }

    [Fact]
    public async Task TypingChanged_carries_the_typists_user_id_not_email()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "typing-" + Guid.NewGuid().ToString("N")[..6], bobId);

        // Both connect; Bob listens for TypingChanged(channelId, userId, userName, isTyping).
        await using var aliceHub = await ConnectHub(aliceEmail);
        await using var bobHub = await ConnectHub(bobEmail);

        var got = new TaskCompletionSource<(int channelId, int userId, string name, bool isTyping)>();
        bobHub.On<int, int, string, bool>("TypingChanged",
            (cid, uid, name, typing) => got.TrySetResult((cid, uid, name, typing)));

        await aliceHub.InvokeAsync("StartTyping", channelId);

        var evt = await got.Task.WaitAsync(TimeSpan.FromSeconds(10));
        evt.channelId.Should().Be(channelId);
        evt.userId.Should().Be(aliceId); // the typist by id — never an email
        evt.isTyping.Should().BeTrue();
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
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId); // DM gate

        // A DM (so Bob gets a directMessage notification by default) — exercises both events at once.
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
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

    // ---- Emoji reactions: toggle, count, history, permissions, validation ----

    /// <summary>Post a message as <paramref name="sender"/> in a channel and return its id.</summary>
    private static async Task<long> Send(HttpClient sender, int channelId, string body)
    {
        var send = await sender.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body, mentionedUserIds = (int[]?)null });
        send.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(send)).GetProperty("id").GetInt64();
    }

    [Fact]
    public async Task Reacting_adds_a_group_and_toggling_the_same_emoji_removes_it()
    {
        var (_, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "react-" + Guid.NewGuid().ToString("N")[..6]);
        var messageId = await Send(alice, channelId, "react to me");

        // First toggle ADDS the reaction → one group, count 1, with the reactor's userId in ReactedByUserIds.
        var add = await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" });
        add.StatusCode.Should().Be(HttpStatusCode.OK);
        var groups = (await Json(add)).EnumerateArray().ToList();
        groups.Should().ContainSingle();
        groups[0].GetProperty("emoji").GetString().Should().Be("👍");
        groups[0].GetProperty("count").GetInt32().Should().Be(1);
        groups[0].TryGetProperty("reactedBy", out _).Should().BeFalse(); // email-privacy: no email list
        groups[0].GetProperty("reactedByUserIds").EnumerateArray().Select(e => e.GetInt32())
            .Should().ContainSingle().And.Contain(aliceId); // exactly the caller, by id

        // Second toggle of the SAME emoji REMOVES it → no groups left.
        var remove = await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" });
        remove.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(remove)).EnumerateArray().Should().BeEmpty();
    }

    [Fact]
    public async Task Two_users_reacting_with_the_same_emoji_yields_count_two_with_both_in_reactedByUserIds()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "react2-" + Guid.NewGuid().ToString("N")[..6], bobId);
        var messageId = await Send(alice, channelId, "double react");

        await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "❤️" });
        var second = await bob.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "❤️" });
        second.StatusCode.Should().Be(HttpStatusCode.OK);

        var groups = (await Json(second)).EnumerateArray().ToList();
        groups.Should().ContainSingle();
        groups[0].GetProperty("count").GetInt32().Should().Be(2);
        // Email-privacy: both reactors are exposed by userId, never email — no "@" in the payload.
        groups[0].TryGetProperty("reactedBy", out _).Should().BeFalse();
        var reactedBy = groups[0].GetProperty("reactedByUserIds").EnumerateArray().Select(e => e.GetInt32()).ToList();
        reactedBy.Should().Contain(aliceId);
        reactedBy.Should().Contain(bobId);
    }

    [Fact]
    public async Task Reactions_appear_in_the_message_history_dto()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var (bobEmail, bob, bobId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "histreact-" + Guid.NewGuid().ToString("N")[..6], bobId);
        var messageId = await Send(alice, channelId, "history reaction");

        await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "🔥" });

        // Bob (a member) reads history and sees the reaction group attached to the message — the reactor is
        // exposed by userId only (email-privacy).
        var hist = (await Json(await bob.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == messageId);
        var reactions = hist.GetProperty("reactions").EnumerateArray().ToList();
        reactions.Should().ContainSingle();
        reactions[0].GetProperty("emoji").GetString().Should().Be("🔥");
        reactions[0].GetProperty("count").GetInt32().Should().Be(1);
        reactions[0].TryGetProperty("reactedBy", out _).Should().BeFalse();
        reactions[0].GetProperty("reactedByUserIds").EnumerateArray().Select(e => e.GetInt32())
            .Should().Contain(aliceId);

        // A message with no reactions still carries an (empty) reactions array — never null.
        var plainId = await Send(alice, channelId, "no reactions here");
        var plain = (await Json(await bob.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == plainId);
        plain.GetProperty("reactions").ValueKind.Should().Be(JsonValueKind.Array);
        plain.GetProperty("reactions").EnumerateArray().Should().BeEmpty();
    }

    [Fact]
    public async Task A_read_only_member_without_chat_send_cannot_react()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (readerEmail, reader, readerId) = await ProvisionUserWithId("chat.read"); // member, but no chat.send
        var channelId = await CreateChannel(alice, "ro-react-" + Guid.NewGuid().ToString("N")[..6], readerId);
        var messageId = await Send(alice, channelId, "look but don't touch");

        // The read-only member is a member of the channel but lacks chat.send → 403 (not 404).
        (await reader.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_non_member_reacting_is_404()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var (_, outsider) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "nm-react-" + Guid.NewGuid().ToString("N")[..6]);
        var messageId = await Send(alice, channelId, "members only react");

        // A non-member (has chat.send, but not in the channel) → 404, never leaking the message exists.
        (await outsider.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // A reaction on a message that doesn't exist at all is also 404.
        (await alice.PostAsJsonAsync("/api/chat/messages/999999999/reactions", new { emoji = "👍" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Concurrent_toggle_of_the_same_reaction_converges_without_throwing()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUserWithId("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "race-react-" + Guid.NewGuid().ToString("N")[..6]);
        var messageId = await Send(alice, channelId, "race to react");

        // Two clients for the SAME user fire the SAME (message, user, emoji) ADD at once. The unique
        // index on (MessageId, UserEmail, Emoji) lets at most one row in; the losing racer must recover
        // from the 23505 violation rather than 500. Both calls succeed and converge on identical groups.
        var second = Client(aliceEmail);
        var first = alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" });
        var firstAgain = second.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "👍" });
        await Task.WhenAll(first, firstAgain);

        (await first).StatusCode.Should().Be(HttpStatusCode.OK);
        (await firstAgain).StatusCode.Should().Be(HttpStatusCode.OK);

        // Exactly one reaction row survived: one group, count 1, the caller in ReactedBy.
        var hist = (await Json(await alice.GetAsync($"/api/chat/channels/{channelId}/messages")))
            .EnumerateArray().First(m => m.GetProperty("id").GetInt64() == messageId);
        var reactions = hist.GetProperty("reactions").EnumerateArray().ToList();
        reactions.Should().ContainSingle();
        reactions[0].GetProperty("emoji").GetString().Should().Be("👍");
        reactions[0].GetProperty("count").GetInt32().Should().Be(1);
        reactions[0].GetProperty("reactedByUserIds").EnumerateArray().Select(e => e.GetInt32())
            .Should().ContainSingle().And.Contain(aliceId);
    }

    [Fact]
    public async Task Reaction_emoji_validation_rejects_empty_too_long_and_control_chars()
    {
        var (_, alice) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "valid-react-" + Guid.NewGuid().ToString("N")[..6]);
        var messageId = await Send(alice, channelId, "validate my reactions");

        // Empty / whitespace-only emoji → 400.
        (await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "   " }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Over 32 chars → 400.
        (await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = new string('x', 33) }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Control / newline characters → 400.
        (await alice.PostAsJsonAsync($"/api/chat/messages/{messageId}/reactions", new { emoji = "a\nb" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
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
