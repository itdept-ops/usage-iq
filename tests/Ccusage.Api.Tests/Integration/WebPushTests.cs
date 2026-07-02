using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Web Push (background notification) plumbing:
/// <list type="bullet">
///   <item><c>GET /api/push/vapid-public</c> returns the PUBLIC key (anon-ok) and NEVER the private key.</item>
///   <item><c>POST /api/push/subscribe</c> upserts caller-scoped (owner from the JWT, not the body), and a
///   re-subscribe of the same endpoint updates rather than duplicating.</item>
///   <item>An endpoint already owned by user A is RE-KEYED to user B on B's subscribe (a device belongs to
///   one user); A no longer owns it.</item>
///   <item><c>DELETE /api/push/subscribe</c> only removes the caller's OWN subscription.</item>
///   <item>The sender is a NO-OP without VAPID keys and NEVER throws (proven against a key-less options).</item>
///   <item>A "gone" (410) push response PRUNES that subscription row.</item>
///   <item>No endpoint leaks the VAPID PRIVATE key.</item>
/// </list>
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class WebPushTests(WebAppFactory factory)
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
        var email = $"push-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    /// <summary>A genuine P-256 ECDH public point (uncompressed, base64url) + 16-byte auth secret, so the
    /// WebPush library's payload encryption succeeds and a real (captured) POST fires. Subscribe-only tests
    /// can use any string (the keys are just stored), but the SENDER tests need valid ECDH material.</summary>
    private const string ValidP256dh =
        "BNLkN2lswKnAQ4_6JHC81I91uYZLOCldE3Fe_NTY3kCMTABS57rQMOkTExQMGuMD24lWC457Ailx4ugUvenEMqY";
    private const string ValidAuth = "oHsM3L8hN8iB1sC-4nA2Nw";

    private static object Sub(string endpoint, string p256dh = "p256dh-key", string auth = "auth-secret") =>
        new { endpoint, keys = new { p256dh, auth } };

    private async Task<List<Ccusage.Api.Data.Entities.PushSubscription>> SubsFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.PushSubscriptions.AsNoTracking().Where(s => s.OwnerEmail == email).ToListAsync();
    }

    // ---- vapid-public ----

    [Fact]
    public async Task Vapid_public_returns_the_public_key_anonymously_and_never_the_private_key()
    {
        // Anonymous client (no Authorization header) — the endpoint is public by design.
        var resp = await factory.CreateClient().GetAsync("/api/push/vapid-public");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain(WebAppFactory.VapidPublicKey);
        // The private key must never appear on any response.
        body.Should().NotContain(WebAppFactory.VapidPrivateKey);

        var json = JsonSerializer.Deserialize<JsonElement>(body);
        json.GetProperty("publicKey").GetString().Should().Be(WebAppFactory.VapidPublicKey);
        json.TryGetProperty("privateKey", out _).Should().BeFalse("the private key is never serialized");
    }

    // ---- subscribe (caller-scoped upsert) ----

    [Fact]
    public async Task Subscribe_creates_a_caller_scoped_row_then_re_subscribe_upserts_not_duplicates()
    {
        var (email, client) = await ProvisionUser("chat.read");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";

        (await client.PostAsJsonAsync("/api/push/subscribe", Sub(endpoint, "key-A", "auth-A")))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var after1 = await SubsFor(email);
        after1.Should().ContainSingle();
        after1[0].Endpoint.Should().Be(endpoint);
        after1[0].OwnerEmail.Should().Be(email);
        after1[0].P256dh.Should().Be("key-A");

        // Re-subscribe the SAME endpoint with rotated keys: UPSERT (still one row), keys refreshed.
        (await client.PostAsJsonAsync("/api/push/subscribe", Sub(endpoint, "key-B", "auth-B")))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var after2 = await SubsFor(email);
        after2.Should().ContainSingle();
        after2[0].P256dh.Should().Be("key-B");
        after2[0].Auth.Should().Be("auth-B");
    }

    [Fact]
    public async Task Subscribe_takes_owner_from_the_jwt_and_re_keys_a_device_to_the_new_owner()
    {
        var (emailA, clientA) = await ProvisionUser("chat.read");
        var (emailB, clientB) = await ProvisionUser("chat.read");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";

        // A subscribes the device.
        (await clientA.PostAsJsonAsync("/api/push/subscribe", Sub(endpoint)))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await SubsFor(emailA)).Should().ContainSingle(s => s.Endpoint == endpoint);

        // B subscribes the SAME endpoint (same physical device, now B's): it re-keys to B; A no longer owns it.
        (await clientB.PostAsJsonAsync("/api/push/subscribe", Sub(endpoint)))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        (await SubsFor(emailB)).Should().ContainSingle(s => s.Endpoint == endpoint);
        (await SubsFor(emailA)).Should().NotContain(s => s.Endpoint == endpoint);
    }

    [Fact]
    public async Task Subscribe_rejects_a_missing_endpoint_or_keys()
    {
        var (_, client) = await ProvisionUser("chat.read");
        (await client.PostAsJsonAsync("/api/push/subscribe", new { endpoint = "", keys = new { p256dh = "x", auth = "y" } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await client.PostAsJsonAsync("/api/push/subscribe", new { endpoint = "https://fcm.googleapis.com/fcm/send/x", keys = new { p256dh = "", auth = "y" } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Subscribe_requires_chat_read_permission()
    {
        var (_, client) = await ProvisionUser(); // no chat.read
        (await client.PostAsJsonAsync("/api/push/subscribe", Sub($"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}")))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- unsubscribe (caller-scoped) ----

    [Fact]
    public async Task Unsubscribe_only_removes_the_callers_own_subscription()
    {
        var (emailA, clientA) = await ProvisionUser("chat.read");
        var (emailB, clientB) = await ProvisionUser("chat.read");
        var epA = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        var epB = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";

        (await clientA.PostAsJsonAsync("/api/push/subscribe", Sub(epA))).EnsureSuccessStatusCode();
        (await clientB.PostAsJsonAsync("/api/push/subscribe", Sub(epB))).EnsureSuccessStatusCode();

        // A tries to delete B's endpoint: caller-scoped ⇒ nothing happens to B's row (idempotent 200).
        (await clientA.DeleteAsync($"/api/push/subscribe?endpoint={Uri.EscapeDataString(epB)}"))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await SubsFor(emailB)).Should().ContainSingle(s => s.Endpoint == epB);

        // A deletes its OWN endpoint: gone.
        (await clientA.DeleteAsync($"/api/push/subscribe?endpoint={Uri.EscapeDataString(epA)}"))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await SubsFor(emailA)).Should().BeEmpty();
    }

    // ---- sender: no-op without keys, never throws ----

    [Fact]
    public async Task Sender_is_a_no_op_without_vapid_keys_and_never_throws()
    {
        var (email, _) = await ProvisionUser("chat.read");
        // Seed a subscription so a configured sender WOULD send.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            db.PushSubscriptions.Add(new Ccusage.Api.Data.Entities.PushSubscription
            {
                OwnerEmail = email, Endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}",
                P256dh = "k", Auth = "a", CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }
        factory.WebPush.Reset();

        // Build a sender with EMPTY options (web-push unconfigured) but the real DB + capturing client.
        using var s2 = factory.Services.CreateScope();
        var realDb = s2.ServiceProvider.GetRequiredService<UsageDbContext>();
        var httpFactory = s2.ServiceProvider.GetRequiredService<IHttpClientFactory>();
        var emptyOptions = Options.Create(new WebPushOptions()); // no keys ⇒ IsConfigured == false
        var sender = new WebPushSender(realDb, emptyOptions, NullLogger<WebPushSender>.Instance, httpFactory);

        sender.IsConfigured.Should().BeFalse();
        // Must not throw, and must not POST anything (no-op short-circuits before touching the DB/HTTP).
        var act = async () => await sender.SendToUserAsync(email, "Title", "Body", "/chat");
        await act.Should().NotThrowAsync();
        factory.WebPush.Count.Should().Be(0);
    }

    [Fact]
    public async Task Sender_with_keys_posts_to_each_subscription_and_does_not_throw()
    {
        var (email, _) = await ProvisionUser("chat.read");
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            db.PushSubscriptions.Add(new Ccusage.Api.Data.Entities.PushSubscription
            {
                OwnerEmail = email, Endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}",
                P256dh = ValidP256dh, Auth = ValidAuth, CreatedUtc = DateTime.UtcNow,
            });
            // Browser-notifications opt-in is now gated SERVER-SIDE; a subscriber has it on.
            db.NotificationPreferences.Add(new Ccusage.Api.Data.Entities.NotificationPreference { UserEmail = email, SurfaceBrowser = true });
            await db.SaveChangesAsync();
        }
        factory.WebPush.Reset(); // 201 by default = accepted.

        using var s2 = factory.Services.CreateScope();
        var sender = s2.ServiceProvider.GetRequiredService<WebPushSender>();
        sender.IsConfigured.Should().BeTrue();

        var act = async () => await sender.SendToUserAsync(email, "You were mentioned", "Alice: hi", "/chat?c=1");
        await act.Should().NotThrowAsync();
        factory.WebPush.Count.Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task Sender_skips_when_browser_notifications_are_off()
    {
        var (email, _) = await ProvisionUser("chat.read");
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            db.PushSubscriptions.Add(new Ccusage.Api.Data.Entities.PushSubscription
            {
                OwnerEmail = email, Endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}",
                P256dh = ValidP256dh, Auth = ValidAuth, CreatedUtc = DateTime.UtcNow,
            });
            // A live subscription exists, but the user turned "Browser notifications" OFF: the server-side
            // gate must skip the send (the client unsubscribe may have failed; the pref is the source of truth).
            db.NotificationPreferences.Add(new Ccusage.Api.Data.Entities.NotificationPreference { UserEmail = email, SurfaceBrowser = false });
            await db.SaveChangesAsync();
        }
        factory.WebPush.Reset();

        using var s2 = factory.Services.CreateScope();
        var sender = s2.ServiceProvider.GetRequiredService<WebPushSender>();
        await sender.SendToUserAsync(email, "Title", "Body", "/chat");
        factory.WebPush.Count.Should().Be(0); // gated off ⇒ nothing sent despite the live subscription.
    }

    // ---- sender: gone (410) pruning ----

    [Fact]
    public async Task A_gone_410_push_prunes_that_subscription()
    {
        var (email, _) = await ProvisionUser("chat.read");
        var endpoint = $"https://fcm.googleapis.com/fcm/send/{Guid.NewGuid():N}";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            db.PushSubscriptions.Add(new Ccusage.Api.Data.Entities.PushSubscription
            {
                OwnerEmail = email, Endpoint = endpoint,
                P256dh = ValidP256dh, Auth = ValidAuth, CreatedUtc = DateTime.UtcNow,
            });
            db.NotificationPreferences.Add(new Ccusage.Api.Data.Entities.NotificationPreference { UserEmail = email, SurfaceBrowser = true });
            await db.SaveChangesAsync();
        }

        factory.WebPush.Reset();
        factory.WebPush.NextStatus = HttpStatusCode.Gone; // the push service says this subscription is gone.

        using (var s2 = factory.Services.CreateScope())
        {
            var sender = s2.ServiceProvider.GetRequiredService<WebPushSender>();
            await sender.SendToUserAsync(email, "Title", "Body", "/chat");
        }

        // The dead subscription was reaped.
        (await SubsFor(email)).Should().NotContain(s => s.Endpoint == endpoint);
        factory.WebPush.Reset(); // restore 201 for other tests sharing the factory.
    }
}
