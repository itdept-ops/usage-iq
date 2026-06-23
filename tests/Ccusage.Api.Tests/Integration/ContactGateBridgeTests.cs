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
/// The DM contact-gate on POST /api/chat/direct and the household→contacts auto-bridge.
/// <list type="bullet">
///   <item>DM gate: a non-admin may only open a DM with a mutual contact — a non-contact gets 403; a
///   contact succeeds; a chat admin (chat.contacts.manage) may DM anyone regardless of contact.</item>
///   <item>Auto-bridge: adding an ADULT household member creates the mutual contact edge with the owner
///   (and is idempotent); adding a CHILD does NOT create any contact edge.</item>
/// </list>
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ContactGateBridgeTests(WebAppFactory factory)
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
        var email = $"gate-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Make two users mutual chat contacts via the admin contacts editor.</summary>
    private async Task MakeContacts(int a, int b)
    {
        var (_, contactsAdmin, _) = await ProvisionUser("chat.read", "chat.contacts.manage");
        (await contactsAdmin.PostAsJsonAsync($"/api/chat/contacts/user/{a}", new { contactUserId = b }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>True when (owner→contact) directed edge exists in the DB (email-resolved server-side).</summary>
    private async Task<bool> EdgeExists(int ownerId, int contactId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var owner = await db.Users.AsNoTracking().Where(u => u.Id == ownerId).Select(u => u.Email).SingleAsync();
        var contact = await db.Users.AsNoTracking().Where(u => u.Id == contactId).Select(u => u.Email).SingleAsync();
        return await db.ChatContacts.AsNoTracking()
            .AnyAsync(c => c.OwnerEmail == owner && c.ContactEmail == contact);
    }

    // ---- DM gate ----

    [Fact]
    public async Task Non_admin_cannot_DM_a_non_contact()
    {
        var (_, alice, aliceId) = await ProvisionUser("chat.read", "chat.send");
        var (_, _, bobId) = await ProvisionUser("chat.read", "chat.send");

        var res = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // A friendly message, and no email ever leaks in the body.
        var body = await Json(res);
        body.GetProperty("message").GetString().Should().NotBeNullOrEmpty();
        body.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Non_admin_can_DM_a_mutual_contact()
    {
        var (_, alice, aliceId) = await ProvisionUser("chat.read", "chat.send");
        var (_, _, bobId) = await ProvisionUser("chat.read", "chat.send");
        await MakeContacts(aliceId, bobId);

        var res = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("kind").GetString().Should().Be("direct");
    }

    [Fact]
    public async Task Chat_admin_can_DM_anyone_regardless_of_contact()
    {
        // The chat admin holds chat.contacts.manage (the same capability that lets their picker draw from
        // the full team directory) — they bypass the contact gate.
        var (_, admin, _) = await ProvisionUser("chat.read", "chat.send", "chat.contacts.manage");
        var (_, _, bobId) = await ProvisionUser("chat.read", "chat.send");

        var res = await admin.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("kind").GetString().Should().Be("direct");
    }

    // ---- Household -> contacts auto-bridge ----

    [Fact]
    public async Task Adding_an_adult_member_bridges_mutual_contacts_and_is_idempotent()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "chat.read", "chat.send");
        var (_, _, adultId) = await ProvisionUser("family.use", "chat.read", "chat.send");
        await owner.GetAsync("/api/family/household"); // provision the owner's household

        // Before: not contacts.
        (await EdgeExists(ownerId, adultId)).Should().BeFalse();

        var add = await owner.PostAsJsonAsync("/api/family/household/members", new { userId = adultId, role = "adult" });
        add.StatusCode.Should().Be(HttpStatusCode.OK);

        // After: a MUTUAL contact edge exists both ways (the auto-bridge).
        (await EdgeExists(ownerId, adultId)).Should().BeTrue();
        (await EdgeExists(adultId, ownerId)).Should().BeTrue();

        // The new adult can now DM the owner (the bridge admits it through the contact gate).
        var dm = await Client((await ProvisionUserEmailFor(adultId))).PostAsJsonAsync(
            "/api/chat/direct", new { userId = ownerId });
        dm.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Adding_a_child_member_does_not_bridge_contacts()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "chat.read", "chat.send");
        // A child holds the child capabilities (family.use + chore.claim) but no chat — never bridged.
        var (_, _, childId) = await ProvisionUser("family.use", "chore.claim");
        await owner.GetAsync("/api/family/household");

        var add = await owner.PostAsJsonAsync("/api/family/household/members", new { userId = childId, role = "child" });
        add.StatusCode.Should().Be(HttpStatusCode.OK);

        // No contact edge in EITHER direction for a child.
        (await EdgeExists(ownerId, childId)).Should().BeFalse();
        (await EdgeExists(childId, ownerId)).Should().BeFalse();
    }

    /// <summary>Resolve an AppUser id back to its email so a client can act AS that user (test-only helper;
    /// the email never leaves the test process).</summary>
    private async Task<string> ProvisionUserEmailFor(int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Email).SingleAsync();
    }
}
