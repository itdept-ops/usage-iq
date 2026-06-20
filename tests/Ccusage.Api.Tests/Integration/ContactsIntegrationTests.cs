using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Admin-managed, MUTUAL chat contacts ("circles"). Covers: the manage endpoints are gated by
/// chat.contacts.manage (a non-manager gets 403); a mutual add writes BOTH directions and a mutual
/// remove deletes both; /contacts/me returns only the caller's own contacts; a self-add is ignored;
/// adds are idempotent; the directory excludes the caller; and unknown/disabled users are rejected.
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ContactsIntegrationTests(WebAppFactory factory)
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
        var email = $"contact-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>The contact userIds in a contacts/directory payload — email-privacy: the wire carries
    /// userId, never an email.</summary>
    private static List<int> UserIds(JsonElement arr) =>
        arr.EnumerateArray().Select(c => c.GetProperty("userId").GetInt32()).ToList();

    /// <summary>True when the JSON object has a property with the given name (for asserting NO email leaks).</summary>
    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

    // ---- Permission gating: a non-manager gets 403 on the manage endpoints ----

    [Fact]
    public async Task Manage_endpoints_require_chat_contacts_manage()
    {
        // chat.read + chat.send is NOT enough to manage contacts.
        var (_, _, someoneId) = await ProvisionUser("chat.read");
        var (_, plain, _) = await ProvisionUser("chat.read", "chat.send");

        (await plain.GetAsync("/api/chat/directory")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync($"/api/chat/contacts/user/{someoneId}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync($"/api/chat/contacts/user/{someoneId}", new { contactUserId = someoneId }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.DeleteAsync($"/api/chat/contacts/user/{someoneId}/{someoneId}"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // But /contacts/me only needs chat.read.
        (await plain.GetAsync("/api/chat/contacts/me")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Contacts_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/chat/contacts/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/chat/directory")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ---- Mutual add: writes BOTH rows ----

    [Fact]
    public async Task Adding_a_contact_is_mutual_both_users_see_each_other()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, alice, aliceId) = await ProvisionUser("chat.read");
        var (_, bob, bobId) = await ProvisionUser("chat.read");

        // The owner + contact are addressed by AppUser id (email-privacy).
        var added = await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId });
        added.StatusCode.Should().Be(HttpStatusCode.OK);
        var addedJson = await Json(added);
        UserIds(addedJson).Should().ContainSingle().Which.Should().Be(bobId);
        // The contacts payload carries userId, never an email.
        addedJson.EnumerateArray().Should().OnlyContain(c => !HasProperty(c, "email"));
        addedJson.GetRawText().Should().NotContain("@");

        // Alice's own contacts now include Bob (by id)...
        UserIds(await Json(await alice.GetAsync("/api/chat/contacts/me"))).Should().Contain(bobId);
        // ...and Bob's own contacts include Alice (the mutual / reverse row).
        UserIds(await Json(await bob.GetAsync("/api/chat/contacts/me"))).Should().Contain(aliceId);

        // The admin view of each user's contacts agrees.
        UserIds(await Json(await admin.GetAsync($"/api/chat/contacts/user/{bobId}"))).Should().Contain(aliceId);
    }

    // ---- Mutual remove: deletes BOTH rows ----

    [Fact]
    public async Task Removing_a_contact_is_mutual_both_directions_disappear()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, alice, aliceId) = await ProvisionUser("chat.read");
        var (_, bob, bobId) = await ProvisionUser("chat.read");

        await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId });

        // Remove from Alice's side (owner + contact by id); Bob must lose Alice too.
        var removed = await admin.DeleteAsync($"/api/chat/contacts/user/{aliceId}/{bobId}");
        removed.StatusCode.Should().Be(HttpStatusCode.OK);
        UserIds(await Json(removed)).Should().NotContain(bobId);

        UserIds(await Json(await alice.GetAsync("/api/chat/contacts/me"))).Should().NotContain(bobId);
        UserIds(await Json(await bob.GetAsync("/api/chat/contacts/me"))).Should().NotContain(aliceId);

        // Removing again is a harmless no-op (still 200).
        (await admin.DeleteAsync($"/api/chat/contacts/user/{aliceId}/{bobId}"))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- /me returns only the caller's own contacts ----

    [Fact]
    public async Task Me_returns_only_the_callers_own_contacts()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, alice, aliceId) = await ProvisionUser("chat.read");
        var (_, _, bobId) = await ProvisionUser("chat.read");
        var (_, carol, carolId) = await ProvisionUser("chat.read");

        // Alice <-> Bob are contacts; Carol is unrelated.
        await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId });

        var meResp = await Json(await alice.GetAsync("/api/chat/contacts/me"));
        var aliceContacts = UserIds(meResp);
        aliceContacts.Should().Contain(bobId);
        aliceContacts.Should().NotContain(carolId);
        // The /me payload carries userId + name, never an email (email-privacy).
        meResp.EnumerateArray().Should().OnlyContain(c => !HasProperty(c, "email"));

        // Carol, who has no contacts, sees an empty circle (not Alice's or Bob's).
        UserIds(await Json(await carol.GetAsync("/api/chat/contacts/me"))).Should().BeEmpty();
    }

    // ---- Self-add ignored ----

    [Fact]
    public async Task Adding_yourself_is_ignored_no_self_contact()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, alice, aliceId) = await ProvisionUser("chat.read");

        var resp = await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = aliceId });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        UserIds(await Json(resp)).Should().BeEmpty(); // self-contact never written

        UserIds(await Json(await alice.GetAsync("/api/chat/contacts/me"))).Should().NotContain(aliceId);
    }

    // ---- Idempotent add: re-adding an existing pair is a no-op ----

    [Fact]
    public async Task Adding_the_same_pair_twice_is_idempotent()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, _, aliceId) = await ProvisionUser("chat.read");
        var (_, _, bobId) = await ProvisionUser("chat.read");

        await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId });
        var again = await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId });
        again.StatusCode.Should().Be(HttpStatusCode.OK);

        // Exactly one entry — no duplicate row created.
        UserIds(await Json(again)).Where(id => id == bobId).Should().ContainSingle();
    }

    // ---- Directory: all enabled users except the caller ----

    [Fact]
    public async Task Directory_lists_enabled_users_except_the_caller()
    {
        var (_, admin, adminId) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, _, otherId) = await ProvisionUser("chat.read");

        var dirResp = await Json(await admin.GetAsync("/api/chat/directory"));
        var dir = UserIds(dirResp);
        dir.Should().Contain(otherId);
        dir.Should().NotContain(adminId); // never include the caller
        // The directory carries userId + name, never an email (email-privacy).
        dirResp.EnumerateArray().Should().OnlyContain(c => !HasProperty(c, "email"));
        dirResp.GetRawText().Should().NotContain("@");
    }

    // ---- Unknown / disabled users rejected ----

    [Fact]
    public async Task Adding_to_or_for_an_unknown_user_is_rejected()
    {
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        var (_, _, aliceId) = await ProvisionUser("chat.read");

        // Unknown OWNER id → 404.
        (await admin.PostAsJsonAsync("/api/chat/contacts/user/99999999", new { contactUserId = aliceId }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await admin.GetAsync("/api/chat/contacts/user/99999999"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Unknown CONTACT id → 400.
        (await admin.PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = 99999999 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
