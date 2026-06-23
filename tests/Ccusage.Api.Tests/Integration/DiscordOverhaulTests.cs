using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Security-first coverage for the Discord overhaul: per-user webhook SSRF rejection + encryption-at-rest +
/// per-user isolation + URL never returned, the system routing table gating, and that a forward never
/// blocks/fails notification creation. Mirrors how the app validates/encrypts/redacts in production.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class DiscordOverhaulTests(WebAppFactory factory)
{
    private HttpClient Admin() => Client(WebAppFactory.AdminEmail);

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<string> ProvisionUser(params string[] perms)
    {
        var email = $"disc-{Guid.NewGuid():N}@test.local";
        (await Admin().PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = perms.Length == 0 ? new[] { "chat.read" } : perms }))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        return email;
    }

    // ---- PER-USER: SSRF rejection on save ----
    [Theory]
    [InlineData("http://discord.com/api/webhooks/1/2")]            // not https
    [InlineData("https://evil.com/api/webhooks/1/2")]              // non-Discord host
    [InlineData("http://169.254.169.254/api/webhooks/1/2")]        // metadata endpoint
    [InlineData("http://127.0.0.1/api/webhooks/1/2")]              // loopback
    [InlineData("https://discord.com/not/webhooks/1/2")]           // bad path
    public async Task Per_user_save_rejects_non_discord_webhooks_with_400(string url)
    {
        var email = await ProvisionUser();
        var res = await Client(email).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = url, surfaceDiscord = true });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- SYSTEM: SSRF rejection on save ----
    [Theory]
    [InlineData("http://discord.com/api/webhooks/1/2")]
    [InlineData("https://evil.com/api/webhooks/1/2")]
    [InlineData("http://169.254.169.254/api/webhooks/1/2")]
    public async Task System_webhook_save_rejects_non_discord_webhooks_with_400(string url)
    {
        var res = await Admin().PutAsJsonAsync("/api/notifications", new
        {
            discordWebhookUrl = url, enabled = true, digestHourLocal = 9, weeklyDay = 1, thresholdUsd = 0,
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- ENCRYPTION ROUND-TRIP: stored blob ≠ plaintext, decrypts, response is hint-only ----
    [Fact]
    public async Task Per_user_webhook_is_encrypted_at_rest_and_only_hint_is_returned()
    {
        var email = await ProvisionUser();
        const string url = "https://discord.com/api/webhooks/998877665544/MyS3cretWebhookToken";

        var putRes = await Client(email).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = url, surfaceDiscord = true });
        putRes.StatusCode.Should().Be(HttpStatusCode.OK);

        // Response exposes ONLY {configured, hint, surfaceDiscord} — never the URL.
        var dto = await putRes.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("configured").GetBoolean().Should().BeTrue();
        dto.GetProperty("surfaceDiscord").GetBoolean().Should().BeTrue();
        var body = dto.GetRawText();
        body.Should().NotContain("MyS3cretWebhookToken");
        body.Should().NotContain("/api/webhooks/998877665544/MyS3cretWebhookToken");
        dto.TryGetProperty("webhookUrl", out _).Should().BeFalse();
        dto.GetProperty("hint").GetString()!.Should().NotContain("MyS3cretWebhookToken");

        // At rest: the stored blob is NOT the plaintext, but DECRYPTS back to it via the same protector.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var protector = scope.ServiceProvider.GetRequiredService<TokenProtector>();
        var pref = await db.NotificationPreferences.AsNoTracking().SingleAsync(p => p.UserEmail == email);
        pref.DiscordWebhookEnc.Should().NotBeNullOrEmpty();
        pref.DiscordWebhookEnc.Should().NotContain("MyS3cretWebhookToken"); // ciphertext, not plaintext
        protector.Unprotect(pref.DiscordWebhookEnc).Should().Be(url);       // decrypts back to the real URL
        pref.DiscordWebhookHint.Should().NotContain("MyS3cretWebhookToken");
    }

    // ---- GET never returns the URL ----
    [Fact]
    public async Task Get_my_discord_never_returns_the_url()
    {
        var email = await ProvisionUser();
        const string url = "https://discord.com/api/webhooks/111222333/AnotherSecretToken";
        await Client(email).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = url, surfaceDiscord = false });

        var get = await Client(email).GetAsync("/api/notifications/me/discord");
        var raw = await get.Content.ReadAsStringAsync();
        raw.Should().NotContain("AnotherSecretToken");
        var dto = JsonDocument.Parse(raw).RootElement;
        dto.GetProperty("configured").GetBoolean().Should().BeTrue();
        dto.GetProperty("surfaceDiscord").GetBoolean().Should().BeFalse();
    }

    // ---- PER-USER ISOLATION: a user only ever reads/sets their OWN ----
    [Fact]
    public async Task Users_cannot_read_or_affect_each_others_discord_config()
    {
        var alice = await ProvisionUser();
        var bob = await ProvisionUser();
        const string aliceUrl = "https://discord.com/api/webhooks/4242/aliceonlytoken";

        await Client(alice).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = aliceUrl, surfaceDiscord = true });

        // Bob's GET is HIS own (unconfigured) — never Alice's.
        var bobDto = await (await Client(bob).GetAsync("/api/notifications/me/discord"))
            .Content.ReadFromJsonAsync<JsonElement>();
        bobDto.GetProperty("configured").GetBoolean().Should().BeFalse();

        // Bob clearing his own webhook must not touch Alice's stored config.
        await Client(bob).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = "", surfaceDiscord = false });

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var alicePref = await db.NotificationPreferences.AsNoTracking().SingleAsync(p => p.UserEmail == alice);
        alicePref.DiscordWebhookEnc.Should().NotBeNullOrEmpty("Bob's change must never affect Alice");
    }

    // ---- CLEARING with "" removes the stored secret + hint ----
    [Fact]
    public async Task Empty_webhook_clears_the_stored_secret()
    {
        var email = await ProvisionUser();
        await Client(email).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = "https://discord.com/api/webhooks/55/tok", surfaceDiscord = true });
        await Client(email).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = "", surfaceDiscord = false });

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var pref = await db.NotificationPreferences.AsNoTracking().SingleAsync(p => p.UserEmail == email);
        pref.DiscordWebhookEnc.Should().BeNull();
        pref.DiscordWebhookHint.Should().BeNull();
    }

    // ---- TEST endpoint is 404 when no webhook saved ----
    [Fact]
    public async Task Test_endpoint_is_404_without_a_saved_webhook()
        => (await Client(await ProvisionUser()).PostAsync("/api/notifications/me/discord/test", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

    // ---- ROUTING TABLE: notifications.manage gates writes; reads need view/manage ----
    [Fact]
    public async Task Routes_require_manage_permission_to_write()
    {
        // A plain chat user has neither notifications.view nor .manage.
        var user = await ProvisionUser("chat.read");
        (await Client(user).GetAsync("/api/notifications/routes"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client(user).PutAsJsonAsync("/api/notifications/routes/daily-digest",
            new { enabled = true, mention = (string?)null }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Admin can read + write a route, and the change round-trips.
        (await Admin().PutAsJsonAsync("/api/notifications/routes/daily-digest",
            new { enabled = true, mention = "@here" })).EnsureSuccessStatusCode();
        var routes = await (await Admin().GetAsync("/api/notifications/routes"))
            .Content.ReadFromJsonAsync<JsonElement>();
        var daily = routes.EnumerateArray().Single(r => r.GetProperty("eventKey").GetString() == "daily-digest");
        daily.GetProperty("enabled").GetBoolean().Should().BeTrue();
        daily.GetProperty("mention").GetString().Should().Be("@here");
    }

    [Fact]
    public async Task Unknown_route_key_is_404()
        => (await Admin().PutAsJsonAsync("/api/notifications/routes/does-not-exist",
            new { enabled = true, mention = (string?)null })).StatusCode.Should().Be(HttpStatusCode.NotFound);

    // ---- FIRE-AND-FORGET: a bad webhook never blocks/fails notification creation (chat send) ----
    [Fact]
    public async Task Forwarding_never_blocks_or_fails_notification_creation()
    {
        // Two users in a DM. The recipient opts into Discord with a (valid-shape but unreachable) webhook so
        // the forward is enqueued + attempted off the request path. The chat send MUST still succeed and the
        // inbox row MUST still be written — forwarding is fire-and-forget and swallows all errors.
        var sender = await ProvisionUser("chat.read", "chat.send");
        var recipient = await ProvisionUser("chat.read", "chat.send");

        // Resolve the recipient's AppUser id (the client addresses by id, never email) and make the pair
        // mutual chat contacts so the DM contact-gate admits the DM.
        int recipientId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            recipientId = await db.Users.Where(u => u.Email == recipient).Select(u => u.Id).SingleAsync();
            await ContactGraph.EnsureMutualAsync(db, sender, recipient, sender, default);
        }

        // Recipient turns on Discord forwarding with a webhook that will never actually deliver.
        (await Client(recipient).PutAsJsonAsync("/api/notifications/me/discord",
            new { webhookUrl = "https://discord.com/api/webhooks/1/willnotdeliver", surfaceDiscord = true }))
            .EnsureSuccessStatusCode();
        // Ensure direct-message notifications are on for the recipient.
        (await Client(recipient).PutAsJsonAsync("/api/inbox/preferences", new
        {
            notifyDirectMessages = true, notifyMentions = true, notifyChannelMessages = false,
            notifySystemEvents = true, surfaceToasts = true, surfaceBrowser = false,
        })).EnsureSuccessStatusCode();

        // Open the DM and send — this is the notification-creation path the forward hooks into.
        var open = await Client(sender).PostAsJsonAsync("/api/chat/direct", new { userId = recipientId });
        open.EnsureSuccessStatusCode();
        var channel = await open.Content.ReadFromJsonAsync<JsonElement>();
        var channelId = channel.GetProperty("id").GetInt32();

        var send = await Client(sender).PostAsJsonAsync($"/api/chat/channels/{channelId}/messages",
            new { body = "hello there" });
        send.StatusCode.Should().Be(HttpStatusCode.OK,
            "the chat send (and its inbox fan-out) must succeed regardless of the Discord forward");

        // The recipient's inbox row was written despite the doomed forward.
        var inbox = await (await Client(recipient).GetAsync("/api/inbox?unreadOnly=true"))
            .Content.ReadFromJsonAsync<JsonElement>();
        inbox.EnumerateArray().Should().NotBeEmpty("the in-app notification is created even when the forward fails");
    }
}
