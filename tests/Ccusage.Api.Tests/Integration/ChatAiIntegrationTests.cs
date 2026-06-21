using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Chat AI assist (catch-up / smart-replies / compose). Clones the family-AI assist contract: gated by the
/// chat.* permissions on top of auth, rate-limited, NEVER auto-sends (the suggestions/summaries are returned
/// and the user acts via the existing send path), and graceful — catch-up ALWAYS 200s with a deterministic
/// plain floor; replies/compose return 503 (never 500) when Gemini is unconfigured (the test host always is,
/// since no Gemini__ApiKey is set). Email-privacy: no email ever appears in a response. None of these routes
/// create a ChatMessage row.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ChatAiIntegrationTests(WebAppFactory factory)
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
        var email = $"chatai-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<int> CreateChannel(HttpClient owner, string name, params int[] memberUserIds)
    {
        var resp = await owner.PostAsJsonAsync("/api/chat/channels",
            new { name, topic = (string?)null, isPrivate = false, memberUserIds });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(resp)).GetProperty("id").GetInt32();
    }

    private static async Task<long> Send(HttpClient sender, int channelId, string body)
    {
        var send = await sender.PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body, mentionedUserIds = (int[]?)null });
        send.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(send)).GetProperty("id").GetInt64();
    }

    /// <summary>Count the messages currently in a channel (via history) — used to assert no AI route sends.</summary>
    private static async Task<int> MessageCount(HttpClient member, int channelId)
    {
        var hist = await member.GetAsync($"/api/chat/channels/{channelId}/messages?limit=100");
        hist.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(hist)).EnumerateArray().Count();
    }

    // ================================ CATCH ME UP ================================

    [Fact]
    public async Task Catch_up_requires_chat_read()
    {
        var (_, noChat, _) = await ProvisionUser("dashboard.view");
        // No chat.read at all -> the permission filter rejects before anything else.
        (await noChat.PostAsync("/api/chat/channels/1/ai/catch-up", null))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Catch_up_is_404_for_a_non_member_even_with_chat_read()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        var (_, outsider, _) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "cu-nm-" + Guid.NewGuid().ToString("N")[..6]);
        await Send(alice, channelId, "members only");

        // A non-member can't catch up on a channel they aren't in — 404, never leaking it exists.
        (await outsider.PostAsync($"/api/chat/channels/{channelId}/ai/catch-up", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Catch_up_falls_back_to_plain_and_never_503s_when_gemini_is_off()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        var (_, bob, bobId) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "cu-plain-" + Guid.NewGuid().ToString("N")[..6], bobId);
        await Send(alice, channelId, "one");
        await Send(bob, channelId, "two");
        await Send(alice, channelId, "three");

        var before = await MessageCount(alice, channelId);

        var resp = await alice.PostAsync($"/api/chat/channels/{channelId}/ai/catch-up", null);
        // ALWAYS 200 — the test host has no Gemini key, so the deterministic plain floor answers.
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = await Json(resp);
        json.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        var summary = json.GetProperty("summary").GetString();
        summary.Should().StartWith("Here's what you missed:");
        summary.Should().Contain("3 messages"); // count of the three non-deleted messages

        // Email-privacy: the plain floor names people but never leaks an email.
        summary.Should().NotContain("@");

        // WRITES NOTHING — the AI route created no message.
        (await MessageCount(alice, channelId)).Should().Be(before);
    }

    [Fact]
    public async Task Catch_up_excludes_deleted_message_bodies_from_the_count()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "cu-del-" + Guid.NewGuid().ToString("N")[..6]);
        await Send(alice, channelId, "keep one");
        var toDelete = await Send(alice, channelId, "delete me");
        (await alice.DeleteAsync($"/api/chat/messages/{toDelete}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var json = await Json(await alice.PostAsync($"/api/chat/channels/{channelId}/ai/catch-up", null));
        json.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        // Only the one surviving (non-deleted) message is counted.
        json.GetProperty("summary").GetString().Should().Contain("1 message");
    }

    // ================================ SMART REPLIES ================================

    [Fact]
    public async Task Replies_require_chat_send_not_just_chat_read()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        // A read-only member of the channel still can't ask for replies (needs chat.send).
        var (_, reader, readerId) = await ProvisionUser("chat.read");
        var channelId = await CreateChannel(alice, "rp-ro-" + Guid.NewGuid().ToString("N")[..6], readerId);
        await Send(alice, channelId, "anyone there?");

        (await reader.PostAsync($"/api/chat/channels/{channelId}/ai/replies", null))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Replies_are_404_for_a_non_member()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        var (_, outsider, _) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "rp-nm-" + Guid.NewGuid().ToString("N")[..6]);
        await Send(alice, channelId, "private");

        (await outsider.PostAsync($"/api/chat/channels/{channelId}/ai/replies", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Replies_are_503_when_gemini_is_unconfigured_and_send_nothing()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        var (_, bob, bobId) = await ProvisionUser("chat.read", "chat.send");
        var channelId = await CreateChannel(alice, "rp-503-" + Guid.NewGuid().ToString("N")[..6], bobId);
        await Send(bob, channelId, "are we still on for friday?");

        var before = await MessageCount(alice, channelId);

        // Member with chat.send, but the test host has no Gemini key -> 503 (never 500), no plain floor.
        (await alice.PostAsync($"/api/chat/channels/{channelId}/ai/replies", null))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        // SENDS NOTHING.
        (await MessageCount(alice, channelId)).Should().Be(before);
    }

    // ================================ COMPOSE ASSIST ================================

    [Fact]
    public async Task Compose_requires_chat_send()
    {
        var (_, readOnly, _) = await ProvisionUser("chat.read");
        (await readOnly.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = "say hi to the team", currentDraft = (string?)null, action = "draft" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Compose_with_nothing_to_work_from_is_400_even_when_gemini_is_off()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");

        // draft action with an empty prompt -> nothing to work from -> 400 (not 503).
        (await alice.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = "   ", currentDraft = "", action = "draft" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // a transform action with an empty draft -> nothing to work from -> 400.
        (await alice.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = "", currentDraft = "", action = "shorten" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Compose_with_an_unknown_action_is_400()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        (await alice.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = "hello", currentDraft = (string?)null, action = "translate" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Compose_with_valid_input_is_503_when_gemini_is_unconfigured()
    {
        var (_, alice, _) = await ProvisionUser("chat.read", "chat.send");
        // Valid input clears the 400 checks, then hits the unconfigured 503 (never 500).
        (await alice.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = "tell everyone the meeting moved to 3pm", currentDraft = (string?)null, action = "draft" }))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        (await alice.PostAsJsonAsync("/api/chat/ai/compose",
                new { prompt = (string?)null, currentDraft = "yo meeting is at 3 k", action = "formal" }))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task All_chat_ai_routes_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsync("/api/chat/channels/1/ai/catch-up", null))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsync("/api/chat/channels/1/ai/replies", null))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/chat/ai/compose", new { prompt = "hi", action = "draft" }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
